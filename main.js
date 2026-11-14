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

// Window sizes are exactly the visible card (no transparent margin), so tools that treat windows as surfaces
// (e.g. snow that settles on window tops) line up with what you actually see.
const LAYOUTS = { full: [408, 178], compact: [408, 72], viz: [408, 58] };
// Older versions used a window 12 px bigger than the card (6 px transparent margin); shift saved positions so the card stays put.
if (!cfg.exact) { if (cfg.x != null) cfg.x += 6; if (cfg.bottom != null) cfg.bottom -= 6; cfg.exact = true; save(); }
// The widget's exact size in DIPs. Windows rounds sizes on displays with different scaling, so reading the size back
// and re-applying it makes the window grow by a pixel at a time; we always set our own size and lock it instead.
let curSize = LAYOUTS.full;
function lockSize(sz) { win.setMinimumSize(sz[0], sz[1]); win.setMaximumSize(sz[0], sz[1]); }
function unlockSize() { win.setMinimumSize(0, 0); win.setMaximumSize(0, 0); }
function placeWidget(x, y, sz) { unlockSize(); win.setBounds({ x, y, width: sz[0], height: sz[1] }); curSize = sz; lockSize(sz); }
const loginOpts = app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] };

// auto-update (installed app only) via GitHub releases
let autoUpdater = null;
if (app.isPackaged) { try { autoUpdater = require('electron-updater').autoUpdater; } catch {} }

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
let tap, tapFails = 0, tapStatus = 'waiting', tapCarry = null, pcmQueue = [], pcmTimer = null;
function flushPcm() {
  pcmTimer = null;
  if (win && !win.isDestroyed() && pcmQueue.length) win.webContents.send('pcm', pcmQueue.length === 1 ? pcmQueue[0] : Buffer.concat(pcmQueue));
  pcmQueue = [];
}
function startTap() {
  const exe = path.join(__dirname, 'tap', 'bin', 'SpotifyTap.exe');
  if (!fs.existsSync(exe)) { tapStatus = 'none'; return; }
  const t0 = Date.now();
  tap = spawn(exe, [], { windowsHide: true });
  tap.stdout.on('data', d => {
    let b = tapCarry ? Buffer.concat([tapCarry, d]) : d;
    if (b.length & 1) { tapCarry = Buffer.from(b.subarray(b.length - 1)); b = b.subarray(0, b.length - 1); } else tapCarry = null;
    // batch ~30 ms of audio per message (about 33 IPC messages/s instead of ~100)
    if (b.length) { pcmQueue.push(Buffer.from(b)); if (!pcmTimer) pcmTimer = setTimeout(flushPcm, 30); }
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

// ---- auto-update: check GitHub releases on start and every 6 h; download in the background; install on restart/quit ----
let updateState = { state: 'idle' }, manualCheck = false, rebuildTray = () => {};
function pushUpdate(s) {
  updateState = s;
  if (win && !win.isDestroyed()) win.webContents.send('update-status', s);
  rebuildTray();
}
function logUpdate(msg) { try { fs.appendFileSync(path.join(os.tmpdir(), 'spotify-overlay-log.txt'), 'updater: ' + msg + '\n'); } catch {} }
function setupUpdater() {
  win.webContents.on('did-finish-load', () => win.webContents.send('update-status', updateState));
  if (!autoUpdater) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', i => { logUpdate('available ' + i.version); pushUpdate({ state: 'downloading', version: i.version }); });
  autoUpdater.on('update-not-available', () => {
    logUpdate('up to date');
    if (manualCheck) pushUpdate({ state: 'uptodate', transient: true }); else pushUpdate({ state: 'idle' });
    manualCheck = false;
  });
  autoUpdater.on('update-downloaded', i => { logUpdate('downloaded ' + i.version); pushUpdate({ state: 'ready', version: i.version }); });
  autoUpdater.on('error', e => {
    logUpdate('error ' + (e && e.message));
    if (manualCheck) pushUpdate({ state: 'error', transient: true });
    manualCheck = false;
  });
  const check = () => { if (cfg.autoUpdate !== false && updateState.state !== 'ready') autoUpdater.checkForUpdates().catch(() => {}); };
  setTimeout(check, 15000);
  setInterval(check, 6 * 3600 * 1000);
}
function checkUpdates() {
  if (!autoUpdater) { pushUpdate({ state: 'dev', transient: true }); return; }
  manualCheck = true; pushUpdate({ state: 'checking', transient: true });
  autoUpdater.checkForUpdates().catch(() => {});
}
function installUpdateNow() {
  if (autoUpdater && updateState.state === 'ready') { app.isQuitting = true; autoUpdater.quitAndInstall(true, true); }
}
ipcMain.on('install-update', installUpdateNow);

function defaultPos() {
  const wa = screen.getPrimaryDisplay().workArea;
  return [wa.x + wa.width - LAYOUTS.full[0] - 20, wa.y + wa.height - LAYOUTS.full[1] - 20];
}

function createWindow() {
  const [dx, dy] = defaultPos();
  // position is stored as the window's bottom edge so layouts can grow upward
  const y = cfg.bottom != null ? cfg.bottom - LAYOUTS.full[1] : (cfg.y ?? dy);
  win = new BrowserWindow({
    width: LAYOUTS.full[0], height: LAYOUTS.full[1], x: cfg.x ?? dx, y,
    transparent: true, frame: false, resizable: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  lockSize(curSize);
  win.setIgnoreMouseEvents(!!cfg.clickThrough, { forward: true });
  win.webContents.on('console-message', (e, level, msg) => {
    try { fs.appendFileSync(path.join(os.tmpdir(), 'spotify-overlay-log.txt'), msg + '\n'); } catch {}
  });
  win.loadFile('index.html');
  win.on('moved', () => { if (inFs) return; const [x, y] = win.getPosition(); cfg.x = x; cfg.bottom = y + curSize[1]; save(); });
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
  setupUpdater();

  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Spotify Overlay');
  const lay = (label, id) => ({ label, click: () => win.webContents.send('set-layout', id) });
  const buildMenu = () => Menu.buildFromTemplate([
    { label: 'Layout', submenu: [lay('Full', 'full'), lay('Compact strip', 'compact'), lay('Visualizer only', 'viz')] },
    { label: 'Full screen (Esc to exit)', click: () => win.webContents.send('toggle-fs') },
    { label: 'Next visualizer style', click: () => win.webContents.send('cycle-viz') },
    { label: 'Click-through (lock)', type: 'checkbox', checked: !!cfg.clickThrough,
      click: i => { cfg.clickThrough = i.checked; save(); win.setIgnoreMouseEvents(i.checked, { forward: true }); } },
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings(loginOpts).openAtLogin,
      click: i => app.setLoginItemSettings({ openAtLogin: i.checked, ...loginOpts }) },
    { label: 'Reset position', click: () => { const [x, y] = defaultPos(); win.setPosition(x, y + LAYOUTS.full[1] - curSize[1]); } },
    { type: 'separator' },
    updateState.state === 'ready'
      ? { label: `Restart to update to v${updateState.version}`, click: () => installUpdateNow() }
      : { label: 'Check for updates now', click: () => checkUpdates() },
    { label: 'Check for updates automatically', type: 'checkbox', checked: cfg.autoUpdate !== false,
      click: i => { cfg.autoUpdate = i.checked; save(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(buildMenu());
  rebuildTray = () => tray.setContextMenu(buildMenu());
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
ipcMain.handle('displays', () => screen.getAllDisplays().map((d, i) => ({
  id: String(d.id), label: `Display ${i + 1} (${d.size.width}×${d.size.height})` + (d.id === screen.getPrimaryDisplay().id ? ' · primary' : '') })));
ipcMain.on('layout', (_, name, displayId) => {
  if (!win) return;
  if (name === 'screen') { // full-screen "now playing" mode: cover a whole display (chosen one, or the one the widget is on)
    if (!inFs) { const [px, py] = win.getPosition(); prevBounds = { x: px, y: py, width: curSize[0], height: curSize[1] }; inFs = true; }
    const chosen = displayId && displayId !== 'follow' ? screen.getAllDisplays().find(d => String(d.id) === String(displayId)) : null;
    unlockSize();
    win.setBounds((chosen || screen.getDisplayMatching(prevBounds)).bounds);
    win.setAlwaysOnTop(true, 'screen-saver'); win.focus();
    return;
  }
  const sz = LAYOUTS[name]; if (!sz) return;
  let x, y; // anchor the bottom edge so layouts grow upward
  if (inFs) { inFs = false; x = prevBounds.x; y = prevBounds.y + curSize[1] - sz[1]; }
  else { const p = win.getPosition(); x = p[0]; y = p[1] + curSize[1] - sz[1]; }
  placeWidget(x, y, sz);
});
// Dragging: follow the real cursor (absolute offset from where the drag began) instead of summing mouse deltas,
// so rounding on scaled monitors can't make the card fall behind the pointer. The exact size is re-stated each time.
let dragState = null, dragTimer = null;
function stopDrag() { clearInterval(dragTimer); dragTimer = null; dragState = null; }
ipcMain.on('drag-start', () => {
  if (!win || inFs) return;
  stopDrag();
  const c = screen.getCursorScreenPoint(), [x, y] = win.getPosition();
  dragState = { cx: c.x, cy: c.y, x, y };
  dragTimer = setInterval(() => {
    if (!dragState || !win || win.isDestroyed()) return stopDrag();
    const p = screen.getCursorScreenPoint();
    win.setBounds({ x: dragState.x + p.x - dragState.cx, y: dragState.y + p.y - dragState.cy, width: curSize[0], height: curSize[1] });
  }, 8);
});
ipcMain.on('drag-end', () => {
  const wasDragging = !!dragState; stopDrag();
  if (inFs || !wasDragging) return;
  const [x, y] = win.getPosition(); cfg.x = x; cfg.bottom = y + curSize[1]; save();
});
ipcMain.on('quit',() => { app.isQuitting = true; app.quit(); });
app.on('before-quit', () => { app.isQuitting = true; if (ps) ps.kill(); if (tap) tap.kill(); });
app.on('window-all-closed', () => app.quit());
