const { app, BrowserWindow, ipcMain, Tray, Menu, desktopCapturer, session, nativeImage, screen } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

let win, tray, ps;
const artBase = path.join(os.tmpdir(), 'spotify-overlay-art-');
const cmdFile = path.join(os.tmpdir(), 'spotify-overlay-cmd.txt');
const cfgFile = path.join(app.getPath('userData'), 'config.json');
const cfg = (() => { try { return JSON.parse(fs.readFileSync(cfgFile)); } catch { return {}; } })();
const save = () => { try { fs.writeFileSync(cfgFile, JSON.stringify(cfg)); } catch {} };

const LAYOUTS = { full: [420, 190], compact: [420, 84], viz: [420, 70] };
const loginOpts = app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] };

// only one overlay at a time
if (!app.requestSingleInstanceLock()) { app.quit(); }
else app.on('second-instance', () => { if (win) { win.show(); } });

function startBridge() {
  ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'smtc.ps1'), '-ArtPath', artBase, '-CmdPath', cmdFile], { windowsHide: true });
  let buf = '';
  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line && win) { try { win.webContents.send('media', JSON.parse(line)); } catch {} }
    }
  });
  ps.on('exit', () => { if (!app.isQuitting) setTimeout(startBridge, 2000); });
}

// ---- Spotify-only audio: helper captures just Spotify's audio (process loopback) and streams mono PCM ----
let tap, tapFails = 0, tapStatus = 'waiting', tapCarry = null;
function startTap() {
  const exe = path.join(__dirname, 'tap', 'bin', 'SpotifyTap.exe');
  if (!fs.existsSync(exe)) { tapStatus = 'none'; return; }
  const t0 = Date.now();
  tap = spawn(exe, [], { windowsHide: true });
  tap.stdout.on('data', d => {
    let b = tapCarry ? Buffer.concat([tapCarry, d]) : d;
    if (b.length & 1) { tapCarry = Buffer.from(b.subarray(b.length - 1)); b = b.subarray(0, b.length - 1); } else tapCarry = null;
    if (win && b.length) win.webContents.send('pcm', Buffer.from(b));
  });
  let eb = ''; tap.stderr.setEncoding('utf8');
  tap.stderr.on('data', s => {
    eb += s; let i;
    while ((i = eb.indexOf('\n')) >= 0) {
      const line = eb.slice(0, i).trim(); eb = eb.slice(i + 1);
      if (line.startsWith('STATUS ')) { tapStatus = line.slice(7); if (win) win.webContents.send('tap-status', tapStatus); }
    }
  });
  tap.on('exit', () => {
    if (app.isQuitting) return;
    tapFails = Date.now() - t0 < 3000 ? tapFails + 1 : 0;
    if (tapFails >= 3) { tapStatus = 'error helper keeps crashing'; return; }
    setTimeout(startTap, 2000);
  });
}
setInterval(() => { if (win) win.webContents.send('tap-status', tapStatus); }, 2000);

function defaultPos() {
  const wa = screen.getPrimaryDisplay().workArea;
  return [wa.x + wa.width - 440, wa.y + wa.height - 210];
}

function createWindow() {
  const [dx, dy] = defaultPos();
  // position is stored as the window's bottom edge so layouts can grow upward
  const y = cfg.bottom != null ? cfg.bottom - 190 : (cfg.y ?? dy);
  win = new BrowserWindow({
    width: 420, height: 190, x: cfg.x ?? dx, y,
    transparent: true, frame: false, resizable: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(!!cfg.clickThrough, { forward: true });
  win.webContents.on('console-message', (e, level, msg) => {
    try { fs.appendFileSync(path.join(os.tmpdir(), 'spotify-overlay-log.txt'), msg + '\n'); } catch {}
  });
  win.loadFile('index.html');
  win.on('moved', () => { if (inFs) return; const b = win.getBounds(); cfg.x = b.x; cfg.bottom = b.y + b.height; save(); });
}

app.whenReady().then(() => {
  // System-audio loopback powers the real visualizer
  session.defaultSession.setDisplayMediaRequestHandler(async (req, cb) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    cb({ video: sources[0], audio: 'loopback' });
  });
  createWindow();
  startBridge();
  startTap();

  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Spotify Overlay');
  const lay = (label, id) => ({ label, click: () => win.webContents.send('set-layout', id) });
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Layout', submenu: [lay('Full', 'full'), lay('Compact strip', 'compact'), lay('Visualizer only', 'viz')] },
    { label: 'Full screen (Esc to exit)', click: () => win.webContents.send('toggle-fs') },
    { label: 'Next visualizer style', click: () => win.webContents.send('cycle-viz') },
    { label: 'Click-through (lock)', type: 'checkbox', checked: !!cfg.clickThrough,
      click: i => { cfg.clickThrough = i.checked; save(); win.setIgnoreMouseEvents(i.checked, { forward: true }); } },
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings(loginOpts).openAtLogin,
      click: i => app.setLoginItemSettings({ openAtLogin: i.checked, ...loginOpts }) },
    { label: 'Reset position', click: () => { const [x, y] = defaultPos(); const h = win.getBounds().height; win.setPosition(x, y + 190 - h); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => win.show());
});

// ---- synced lyrics from LRCLIB (free, no key). Only the song title/artist/album/length are sent. ----
const lyricsCache = new Map();
function parseLrc(txt) {
  const out = [];
  for (const raw of txt.split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!tags.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tags) out.push({ t: (+m[1]) * 60 + parseFloat(m[2]), text });
  }
  return out.sort((a, b) => a.t - b.t);
}
async function lrc(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'SpotifyOverlay/1.0' }, signal: AbortSignal.timeout(7000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
ipcMain.handle('lyrics', async (_, q) => {
  const key = q.title + '|' + q.artist;
  if (lyricsCache.has(key)) return lyricsCache.get(key);
  const clean = q.title.replace(/\s*[\(\[].*?[\)\]]/g, '').replace(/\s+-\s+.*$/, '').trim() || q.title;
  const a1 = q.artist.split(/,|&| feat\.?| x /i)[0].trim();
  const e = encodeURIComponent, dur = Math.round(q.dur || 0);
  let res = null;
  const tries = [[q.title, q.artist], [clean, q.artist], [clean, a1]];
  for (const [t, a] of tries) {
    const j = await lrc(`https://lrclib.net/api/get?track_name=${e(t)}&artist_name=${e(a)}&album_name=${e(q.album || '')}&duration=${dur}`);
    if (j && j.syncedLyrics) { res = j.syncedLyrics; break; }
  }
  if (!res) {
    const arr = await lrc(`https://lrclib.net/api/search?q=${e(clean + ' ' + a1)}`);
    if (Array.isArray(arr)) {
      const ok = arr.filter(x => x.syncedLyrics);
      const best = ok.find(x => Math.abs((x.duration || 0) - dur) <= 5) || ok[0];
      if (best) res = best.syncedLyrics;
    }
  }
  const out = res ? { lines: parseLrc(res) } : null;
  lyricsCache.set(key, out);
  return out;
});

ipcMain.on('cmd',(_, c) => {
  if (/^(playpause|next|prev|seek:[0-9.]+|vol:[+-]?[0-9.]+|volset:[0-9.]+)$/.test(c)) { try { fs.appendFileSync(cmdFile, c + '\n'); } catch {} }
});
let inFs = false, prevBounds = null;
ipcMain.on('layout', (_, name) => {
  if (!win) return;
  if (name === 'screen') { // full-screen "now playing" mode: cover the whole display the widget is on
    if (!inFs) { prevBounds = win.getBounds(); inFs = true; }
    win.setBounds(screen.getDisplayMatching(prevBounds).bounds);
    win.setAlwaysOnTop(true, 'screen-saver'); win.focus();
    return;
  }
  if (inFs) { inFs = false; if (prevBounds) win.setBounds(prevBounds); }
  const sz = LAYOUTS[name]; if (!sz) return;
  const b = win.getBounds();
  win.setBounds({ x: b.x, y: b.y + b.height - sz[1], width: sz[0], height: sz[1] });
});
ipcMain.on('drag', (_, dx, dy) => {
  if (!win) return;
  const b = win.getBounds();
  win.setBounds({ x: b.x + Math.round(dx), y: b.y + Math.round(dy), width: b.width, height: b.height });
});
ipcMain.on('drag-end', () => { if (inFs) return; const b = win.getBounds(); cfg.x = b.x; cfg.bottom = b.y + b.height; save(); });
ipcMain.on('quit',() => { app.isQuitting = true; app.quit(); });
app.on('before-quit', () => { app.isQuitting = true; if (ps) ps.kill(); if (tap) tap.kill(); });
app.on('window-all-closed', () => app.quit());
