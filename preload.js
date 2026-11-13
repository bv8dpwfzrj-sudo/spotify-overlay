const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  onMedia: cb => ipcRenderer.on('media', (_, m) => cb(m)),
  onCycleViz: cb => ipcRenderer.on('cycle-viz', cb),
  onSetLayout: cb => ipcRenderer.on('set-layout', (_, l) => cb(l)),
  cmd: c => ipcRenderer.send('cmd', String(c)),
  setLayout: (l, d) => ipcRenderer.send('layout', l, d),
  displays: () => ipcRenderer.invoke('displays'),
  onUpdate: cb => ipcRenderer.on('update-status', (_, s) => cb(s)),
  installUpdate: () => ipcRenderer.send('install-update'),
  lyrics: q => ipcRenderer.invoke('lyrics', q),
  onToggleFs: cb => ipcRenderer.on('toggle-fs', cb),
  onPcm: cb => ipcRenderer.on('pcm', (_, b) => cb(b)),
  onTapStatus: cb => ipcRenderer.on('tap-status', (_, s) => cb(s)),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  quit:() => ipcRenderer.send('quit'),
});
