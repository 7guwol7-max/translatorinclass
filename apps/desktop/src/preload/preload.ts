// 화면(renderer)에 window.api 로 필요한 기능만 노출한다. 키는 화면으로 넘어오지 않는다.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { RendererApi } from '../shared/types';

function listen<T>(channel: string) {
  return (cb: (payload: T) => void) => {
    const handler = (_event: IpcRendererEvent, payload: T) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  };
}

const api: RendererApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  getKeyStatus: () => ipcRenderer.invoke('keys:status'),
  saveKey: (provider, key) => ipcRenderer.invoke('keys:save', provider, key),
  clearKey: (provider) => ipcRenderer.invoke('keys:clear', provider),
  testKey: (provider) => ipcRenderer.invoke('keys:test', provider),
  startSession: () => ipcRenderer.invoke('session:start'),
  stopSession: () => ipcRenderer.invoke('session:stop'),
  sendSegment: (channel, pcm, utterance) => ipcRenderer.send('audio:segment', channel, pcm, utterance),
  sendAudio: (channel, utterance, pcm) => ipcRenderer.send('audio:stream', channel, utterance, pcm),
  endAudio: (channel, utterance) => ipcRenderer.send('audio:stream-end', channel, utterance),
  testLive: () => ipcRenderer.invoke('live:test'),
  getLiveStatus: () => ipcRenderer.invoke('live:status'),
  onLiveStatus: listen('live'),
  getQuota: () => ipcRenderer.invoke('quota:get'),
  getStudentLink: () => ipcRenderer.invoke('link:get'),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  onCaption: listen('caption'),
  onQuota: listen('quota'),
  onStatus: listen('status'),
  onSettings: listen('settings'),
  onStudentLink: listen('link'),
  onToggleListening: (cb) => listen<void>('session:toggle')(() => cb()),
  onOverlayMoveMode: listen('overlay:move-mode'),
  onSessionStopped: listen('session:stopped'),
  getListening: () => ipcRenderer.invoke('session:state'),
  onListening: listen('session:listening'),
  requestToggleListening: () => ipcRenderer.send('session:request-toggle'),
  aihubSearch: (keyword) => ipcRenderer.invoke('aihub:search', keyword),
  aihubDetail: (id) => ipcRenderer.invoke('aihub:detail', id),
  getDisplays: () => ipcRenderer.invoke('overlay:displays'),
  onDisplays: listen('displays'),
  placeOverlay: (placement) => ipcRenderer.invoke('overlay:place', placement),
  setOverlayVisible: (visible) => ipcRenderer.invoke('overlay:set-visible', visible),
  onOverlayVisible: listen('overlay:visible'),
  toggleMoveMode: () => ipcRenderer.invoke('overlay:toggle-move'),
  setOverlayInteractive: (interactive) => ipcRenderer.send('overlay:interactive', interactive),
  overlayPointer: (kind, phase) => ipcRenderer.send('overlay:pointer', kind, phase),
  nudgeOverlayFont: (delta) => ipcRenderer.send('overlay:font', delta),
};

contextBridge.exposeInMainWorld('api', api);
