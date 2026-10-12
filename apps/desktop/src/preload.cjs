// Ponte segura entre a janela e o processo principal: a página só enxerga estas funções, nunca o Node.
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (arg) => ipcRenderer.invoke(`sg:${channel}`, arg);
const subscribe = (channel) => (callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(`sg:${channel}`, listener);
  return () => ipcRenderer.removeListener(`sg:${channel}`, listener);
};

contextBridge.exposeInMainWorld('karaoke', {
  snapshot: call('snapshot'),
  buildEngine: call('buildEngine'),
  pair: call('pair'),
  unpair: call('unpair'),
  startAgent: call('startAgent'),
  stopAgent: call('stopAgent'),
  createRoom: call('createRoom'),
  youtubeLogin: call('youtubeLogin'),
  youtubeStatus: call('youtubeStatus'),
  importFile: call('importFile'),
  hardware: call('hardware'),
  settings: call('settings'),
  checkUpdate: call('checkUpdate'),
  applyUpdate: call('applyUpdate'),
  loginItem: call('loginItem'),
  open: call('open'),
  pickAudio: call('pickAudio'),
  onState: subscribe('state'),
});
