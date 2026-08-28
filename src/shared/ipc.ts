import type { BuildOutputLine, BuildStatus } from './build'
import type { CommandId } from './commands'
import type { BoardDefinition } from './board'
import type {
  DeviceCommandMessage,
  DeviceEventMessage,
  DeviceSnapshotMessage
} from './devices/messages'
import type { Diagnostic } from './diagnostics'
import type { EmulatorLaunchOptions, EmulatorStatus } from './emulator'
import type { FileNode } from './files'
import type { SerialLine } from './serial'
import type { WorkspaceState } from './workspace'

export type { EmulatorLaunchOptions }

export const IpcChannel = {
  workspaceLoad: 'workspace:load',
  workspaceSave: 'workspace:save',
  appInfo: 'app:info',
  windowMinimise: 'window:minimise',
  windowToggleMaximise: 'window:toggle-maximise',
  windowClose: 'window:close',
  windowState: 'window:state',
  menuCommand: 'menu:command',
  emulatorOpenFirmware: 'emulator:open-firmware',
  emulatorStart: 'emulator:start',
  emulatorStop: 'emulator:stop',
  emulatorReset: 'emulator:reset',
  emulatorStatus: 'emulator:status',
  serialData: 'serial:data',
  serialWrite: 'serial:write',
  projectOpen: 'project:open',
  projectReadTree: 'project:read-tree',
  projectReadFile: 'project:read-file',
  projectFileChanged: 'project:file-changed',
  buildStart: 'build:start',
  buildCancel: 'build:cancel',
  buildClean: 'build:clean',
  buildState: 'build:state',
  buildOutput: 'build:output',
  buildDiagnostics: 'build:diagnostics',
  devicesLoad: 'device:load',
  deviceSnapshot: 'device:snapshot',
  deviceEvent: 'device:event',
  deviceDiagnostic: 'device:diagnostic',
  deviceCommand: 'device:command'
} as const

export interface AppInfo {
  version: string
  platform: NodeJS.Platform
  isDev: boolean
}

export interface WindowState {
  maximised: boolean
  fullScreen: boolean
  focused: boolean
}

export interface OpenProjectResult {
  /** Absolute project directory. */
  dir: string
  /** Display name — the directory's basename. */
  name: string
  /** Environments from `platformio.ini`, in file order. */
  envs: string[]
}

export interface BuildRequest {
  projectDir: string
  env: string
  /** Emulator launch options for the board, forwarded to the merge/boot step. */
  emulator: EmulatorLaunchOptions
}

export interface PinBenchApi {
  appInfo(): Promise<AppInfo>
  workspace: {
    load(): Promise<WorkspaceState>
    save(state: WorkspaceState): void
  }
  window: {
    minimise(): void
    toggleMaximise(): void
    close(): void
    onStateChange(listener: (state: WindowState) => void): () => void
  }
  onMenuCommand(listener: (command: CommandId) => void): () => void
  emulator: {
    openFirmware(): Promise<string | null>
    start(firmwarePath: string, options?: EmulatorLaunchOptions): void
    stop(): void
    reset(): void
    onStatus(listener: (status: EmulatorStatus) => void): () => void
  }
  serial: {
    write(text: string): void
    onData(listener: (lines: SerialLine[]) => void): () => void
  }
  project: {
    open(): Promise<OpenProjectResult | null>
    /** Immediate children of `dir`, or of the project root when omitted. */
    readTree(dir?: string): Promise<FileNode[]>
    readFile(path: string): Promise<string>
    onFileChanged(listener: (payload: { path: string }) => void): () => void
  }
  build: {
    start(request: BuildRequest): void
    cancel(): void
    clean(projectDir: string): void
    onState(listener: (status: BuildStatus) => void): () => void
    onOutput(listener: (line: BuildOutputLine) => void): () => void
    onDiagnostics(listener: (rows: Diagnostic[]) => void): () => void
  }
  devices: {
    /** Hand the device host the current board so it can instantiate models. */
    load(board: BoardDefinition): void
    /** A device model's observable state changed. */
    onSnapshot(listener: (message: DeviceSnapshotMessage) => void): () => void
    /** A device model appended a row to its OUT-panel event log. */
    onEvent(listener: (message: DeviceEventMessage) => void): () => void
    /** A device model raised a diagnostic (unimplemented op, quarantine, …). */
    onDiagnostic(listener: (row: Diagnostic) => void): () => void
    /** Send a command from an IN panel to a device model (wired from M7). */
    command(message: DeviceCommandMessage): void
  }
}
