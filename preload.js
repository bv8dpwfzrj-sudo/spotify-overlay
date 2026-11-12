const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  onMedia: cb => ipcRenderer.on('media', (_, m) => cb(m)),
  onCycleViz: cb => ipcRenderer.on('cycle-viz', cb),
  onSetLayout: cb => ipcRenderer.on('set-layout', (_, l) => cb(l)),
  cmd: c => ipcRenderer.send('cmd', String(c)),
  setLayout: l => ipcRenderer.send('layout', l),
  lyrics: q => ipcRenderer.invoke('lyrics', q),
  onToggleFs: cb => ipcRenderer.on('toggle-fs', cb),
  onPcm: cb => ipcRenderer.on('pcm', (_, b) => cb(b)),
  onTapStatus: cb => ipcRenderer.on('tap-status', (_, s) => cb(s)),
  drag: (dx, dy) => ipcRenderer.send('drag', dx, dy),
  dragEnd: () => ipcRenderer.send('drag-end'),
  quit:() => ipcRenderer.send('quit'),
});
