import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { AppInfo, PinBenchApi, WindowState } from '../shared/ipc'
import type { CommandId } from '../shared/commands'
import type { EmulatorStatus } from '../shared/emulator'
import type { SerialLine } from '../shared/serial'
import type { WorkspaceState } from '../shared/workspace'

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
  onMenuCommand: (listener) => subscribe<CommandId>(IpcChannel.menuCommand, listener),
  emulator: {
    openFirmware: () => ipcRenderer.invoke(IpcChannel.emulatorOpenFirmware) as Promise<string | null>,
    start: (firmwarePath: string) => ipcRenderer.send(IpcChannel.emulatorStart, firmwarePath),
    stop: () => ipcRenderer.send(IpcChannel.emulatorStop),
    reset: () => ipcRenderer.send(IpcChannel.emulatorReset),
    onStatus: (listener) => subscribe<EmulatorStatus>(IpcChannel.emulatorStatus, listener)
  },
  serial: {
    write: (text: string) => ipcRenderer.send(IpcChannel.serialWrite, text),
    onData: (listener) => subscribe<SerialLine[]>(IpcChannel.serialData, listener)
  }
}

contextBridge.exposeInMainWorld('pinbench', api)
