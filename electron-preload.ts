import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),
  setCompactMode: (compact: boolean) => ipcRenderer.invoke('set-compact-mode', compact),
  typeTextAtCursor: (text: string) => ipcRenderer.invoke('type-text-at-cursor', text),
  startLive: () => ipcRenderer.invoke('live-start'),
  sendLiveAudio: (data: string) => ipcRenderer.invoke('live-audio', data),
  stopLive: () => ipcRenderer.invoke('live-stop'),
  transcribeAudio: (input: unknown) => ipcRenderer.invoke('transcribe-audio', input),
  exportDrive: (input: unknown) => ipcRenderer.invoke('export-drive', input),
  startRecordingFile: () => ipcRenderer.invoke('recording-file-start'),
  appendRecordingChunk: (chunk: ArrayBuffer) => ipcRenderer.invoke('recording-file-append', chunk),
  finishRecordingFile: (input: unknown) => ipcRenderer.invoke('recording-file-finish', input),
  onLiveText: (callback: (text: string) => void) => ipcRenderer.on('live-text', (_, text) => callback(text)),
  onLiveError: (callback: (error: string) => void) => ipcRenderer.on('live-error', (_, error) => callback(error)),
  onLiveClosed: (callback: (code: number) => void) => ipcRenderer.on('live-closed', (_, code) => callback(code)),
  onToggleRecording: (callback: () => void) => {
    ipcRenderer.on('toggle-recording-hotkey', () => callback());
  },
});
