import type { BuildOutputLine, BuildStatus } from './build'
import type { CommandId } from './commands'
import type { BoardDefinition } from './board'
import type { ProjectFile } from './project'
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
  boardLoad: 'board:load',
  projectFileOpen: 'projectfile:open',
  projectFileSave: 'projectfile:save',
  projectFileRecent: 'projectfile:recent',
  buildStart: 'build:start',
  buildCancel: 'build:cancel',
  buildClean: 'build:clean',
  buildState: 'build:state',
  buildOutput: 'build:output',
  buildDiagnostics: 'build:diagnostics',
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

export type BoardLoadResult = { board: BoardDefinition } | { error: string }

/** A `.pinbench` file the main process opened, with its PlatformIO project re-adopted. */
export interface ProjectFileResult {
  /** Absolute path of the `.pinbench` file. */
  path: string
  project: ProjectFile
  /** The re-opened PlatformIO project, or null if the file names none / it is gone. */
  pio: OpenProjectResult | null
}

export type ProjectSaveResult = { path: string } | { canceled: true }

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
  board: {
    /** Load and validate a board definition by id; the host also feeds it to the device host. */
    load(id?: string): Promise<BoardLoadResult>
  }
  projectFile: {
    /** Prompt for a `.pinbench` file and open it, re-adopting its PlatformIO project. */
    open(): Promise<ProjectFileResult | null>
    /** Write `project`; when `path` is null, prompt for one. */
    save(path: string | null, project: ProjectFile): Promise<ProjectSaveResult>
    /** The most recently opened `.pinbench` file, for auto-reopen on launch. */
    recent(): Promise<ProjectFileResult | null>
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
