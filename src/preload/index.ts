import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, ApplyResult, ModelListResult, ProviderProfile } from '../shared/types';

type WatchedFile = {
  watchId: string;
  filePath: string;
  content: string;
  error?: string;
};

const api = {
  loadState: (): Promise<AppState> => ipcRenderer.invoke('state:load'),
  saveState: (state: AppState): Promise<AppState> => ipcRenderer.invoke('state:save', state),
  applyTarget: (targetId: string, state: AppState): Promise<ApplyResult> =>
    ipcRenderer.invoke('target:apply', targetId, state),
  applyAll: (state: AppState): Promise<ApplyResult[]> => ipcRenderer.invoke('target:applyAll', state),
  fetchProviderModels: (provider: ProviderProfile): Promise<ModelListResult> => ipcRenderer.invoke('provider:models', provider),
  readTarget: (filePath: string): Promise<string> => ipcRenderer.invoke('target:read', filePath),
  watchTarget: (watchId: string, filePath: string): Promise<WatchedFile> => ipcRenderer.invoke('target:watch', watchId, filePath),
  unwatchTarget: (watchId?: string): Promise<void> => ipcRenderer.invoke('target:unwatch', watchId),
  onTargetChanged: (callback: (payload: WatchedFile) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: WatchedFile): void => callback(payload);
    ipcRenderer.on('target:changed', listener);
    return () => ipcRenderer.removeListener('target:changed', listener);
  },
  revealPath: (filePath: string): Promise<boolean> => ipcRenderer.invoke('path:reveal', filePath),
  choosePath: (): Promise<string | undefined> => ipcRenderer.invoke('path:choose')
};

contextBridge.exposeInMainWorld('agentRouter', api);

export type AgentRouterApi = typeof api;
