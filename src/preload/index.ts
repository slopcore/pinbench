import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type {
  AppInfo,
  BoardLoadResult,
  BuildRequest,
  EmulatorLaunchOptions,
  OpenProjectResult,
  PinBenchApi,
  ProjectFileResult,
  ProjectSaveResult,
  WindowState
} from '../shared/ipc'
import type { ProjectFile } from '../shared/project'
import type { BuildOutputLine, BuildStatus } from '../shared/build'
import type { CommandId } from '../shared/commands'
import type {
  DeviceCommandMessage,
  DeviceEventMessage,
  DeviceSnapshotMessage
} from '../shared/devices/messages'
import type { Diagnostic } from '../shared/diagnostics'
import type { EmulatorStatus } from '../shared/emulator'
import type { FileNode } from '../shared/files'
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
  board: {
    load: (id?: string) => ipcRenderer.invoke(IpcChannel.boardLoad, id) as Promise<BoardLoadResult>
  },
  projectFile: {
    open: () => ipcRenderer.invoke(IpcChannel.projectFileOpen) as Promise<ProjectFileResult | null>,
    save: (path: string | null, project: ProjectFile) =>
      ipcRenderer.invoke(IpcChannel.projectFileSave, path, project) as Promise<ProjectSaveResult>,
    recent: () =>
      ipcRenderer.invoke(IpcChannel.projectFileRecent) as Promise<ProjectFileResult | null>
  },
  window: {
    minimise: () => ipcRenderer.send(IpcChannel.windowMinimise),
    toggleMaximise: () => ipcRenderer.send(IpcChannel.windowToggleMaximise),
    close: () => ipcRenderer.send(IpcChannel.windowClose),
    onStateChange: (listener) => subscribe<WindowState>(IpcChannel.windowState, listener)
  },
  onMenuCommand: (listener) => subscribe<CommandId>(IpcChannel.menuCommand, listener),
  emulator: {
    openFirmware: () =>
      ipcRenderer.invoke(IpcChannel.emulatorOpenFirmware) as Promise<string | null>,
    start: (firmwarePath: string, options?: EmulatorLaunchOptions) =>
      ipcRenderer.send(IpcChannel.emulatorStart, firmwarePath, options),
    stop: () => ipcRenderer.send(IpcChannel.emulatorStop),
    reset: () => ipcRenderer.send(IpcChannel.emulatorReset),
    onStatus: (listener) => subscribe<EmulatorStatus>(IpcChannel.emulatorStatus, listener)
  },
  serial: {
    write: (text: string) => ipcRenderer.send(IpcChannel.serialWrite, text),
    onData: (listener) => subscribe<SerialLine[]>(IpcChannel.serialData, listener)
  },
  project: {
    open: () => ipcRenderer.invoke(IpcChannel.projectOpen) as Promise<OpenProjectResult | null>,
    readTree: (dir?: string) =>
      ipcRenderer.invoke(IpcChannel.projectReadTree, dir) as Promise<FileNode[]>,
    readFile: (path: string) =>
      ipcRenderer.invoke(IpcChannel.projectReadFile, path) as Promise<string>,
    onFileChanged: (listener) =>
      subscribe<{ path: string }>(IpcChannel.projectFileChanged, listener)
  },
  build: {
    start: (request: BuildRequest) => ipcRenderer.send(IpcChannel.buildStart, request),
    cancel: () => ipcRenderer.send(IpcChannel.buildCancel),
    clean: (projectDir: string) => ipcRenderer.send(IpcChannel.buildClean, projectDir),
    onState: (listener) => subscribe<BuildStatus>(IpcChannel.buildState, listener),
    onOutput: (listener) => subscribe<BuildOutputLine>(IpcChannel.buildOutput, listener),
    onDiagnostics: (listener) => subscribe<Diagnostic[]>(IpcChannel.buildDiagnostics, listener)
  },
  devices: {
    onSnapshot: (listener) => subscribe<DeviceSnapshotMessage>(IpcChannel.deviceSnapshot, listener),
    onEvent: (listener) => subscribe<DeviceEventMessage>(IpcChannel.deviceEvent, listener),
    onDiagnostic: (listener) => subscribe<Diagnostic>(IpcChannel.deviceDiagnostic, listener),
    command: (message: DeviceCommandMessage) => ipcRenderer.send(IpcChannel.deviceCommand, message)
  }
}

contextBridge.exposeInMainWorld('pinbench', api)
