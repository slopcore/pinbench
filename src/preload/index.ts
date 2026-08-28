import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { AppInfo, PinBenchApi, WindowState } from '../shared/ipc'
import type { CommandId } from '../shared/commands'
import type { WorkspaceState } from '../shared/workspace'

/**
 * Subscribe to a main-process event, handing the renderer a plain unsubscribe
 * function. The raw `IpcRendererEvent` never crosses the bridge.
 */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api: PinBenchApi = {
  appInfo: () => ipcRenderer.invoke(IpcChannel.appInfo) as Promise<AppInfo>,
  workspace: {
    load: () => ipcRenderer.invoke(IpcChannel.workspaceLoad) as Promise<WorkspaceState>,
    save: (state: WorkspaceState) => ipcRenderer.send(IpcChannel.workspaceSave, state)
  },
  window: {
    minimise: () => ipcRenderer.send(IpcChannel.windowMinimise),
    toggleMaximise: () => ipcRenderer.send(IpcChannel.windowToggleMaximise),
    close: () => ipcRenderer.send(IpcChannel.windowClose),
    onStateChange: (listener) => subscribe<WindowState>(IpcChannel.windowState, listener)
  },
  onMenuCommand: (listener) => subscribe<CommandId>(IpcChannel.menuCommand, listener)
}

contextBridge.exposeInMainWorld('pinbench', api)
