// The safe bridge between the window and the main process: the page sees only these functions, never Node.
// It is CommonJS: Electron loads a sandboxed preload with `require`.
import electron = require('electron');
import type { KaraokeBridge, Snapshot, Tabs } from '../ui/bridge.ts';

const { contextBridge, ipcRenderer } = electron;
const call = (channel: string) => (arg?: unknown) => ipcRenderer.invoke(`sg:${channel}`, arg);
const subscribe = <T,>(channel: string) => (callback: (payload: T) => void) => {
  const listener = (_event: unknown, payload: T) => callback(payload);
  ipcRenderer.on(`sg:${channel}`, listener);
  return () => {
    ipcRenderer.removeListener(`sg:${channel}`, listener);
  };
};

const bridge: KaraokeBridge = {
  snapshot: call('snapshot'),
  buildEngine: call('buildEngine'),
  pair: call('pair'),
  requestCode: call('requestCode'),
  unpair: call('unpair'),
  startAgent: call('startAgent'),
  stopAgent: call('stopAgent'),
  createRoom: call('createRoom'),
  youtubeLogin: call('youtubeLogin'),
  youtubeStatus: call('youtubeStatus'),
  importFile: call('importFile'),
  hardware: call('hardware'),
  stats: call('stats'),
  settings: call('settings'),
  checkUpdate: call('checkUpdate'),
  applyUpdate: call('applyUpdate'),
  loginItem: call('loginItem'),
  open: call('open'),
  pickAudio: call('pickAudio'),
  pickFolder: call('pickFolder'),
  setLibrary: call('setLibrary'),
  cancelBusy: call('cancelBusy'),
  openRoom: call('openRoom'),
  selectTab: call('selectTab'),
  selectRoom: call('selectRoom'),
  selectSub: call('selectSub'),
  closeRoom: call('closeRoom'),
  settingsOpen: call('settingsOpen'),
  layout: call('layout'),
  onState: subscribe<Snapshot>('state'),
  onTabs: subscribe<Tabs>('tabs'),
};

contextBridge.exposeInMainWorld('karaoke', bridge);
