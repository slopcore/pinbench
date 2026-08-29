import type { BuildOutputLine, BuildStatus } from './build'
import type { CommandId } from './commands'
import type { BoardDefinition } from './board'
import type { BoardEdit } from './boardEdit'
import type { PartConfigValue } from './partConfig'
import type { ProjectFile } from './project'
import type {
  DeviceCommandMessage,
  DeviceEventMessage,
  DeviceFramebufferMessage,
  DeviceSnapshotMessage
} from './devices/messages'
import type { Diagnostic } from './diagnostics'
import type { EmulatorLaunchOptions, EmulatorStatus } from './emulator'
import type { FileNode } from './files'
import type { SerialLine } from './serial'
import type { SerialPortInfo, UsbFlashMode, UsbFlashStatus } from './usb-flash'
import type { WorkspaceState } from './workspace'

export type { SerialPortInfo, UsbFlashMode, UsbFlashStatus }

export type { EmulatorLaunchOptions }

export const IpcChannel = {
  workspaceLoad: 'workspace:load',
  workspaceSave: 'workspace:save',
  appInfo: 'app:info',
  appLaunchState: 'app:launch-state',
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
  boardList: 'board:list',
  boardSaveProfile: 'board:save-profile',
  boardRemember: 'board:remember',
  exportPinHeader: 'board:export-pin-header',
  importPinHeader: 'board:import-pin-header',
  projectSetFolderState: 'project:set-folder-state',
  projectFileOpen: 'projectfile:open',
  projectFileSave: 'projectfile:save',
  projectFileRecent: 'projectfile:recent',
  buildStart: 'build:start',
  buildCancel: 'build:cancel',
  buildClean: 'build:clean',
  buildState: 'build:state',
  buildOutput: 'build:output',
  buildDiagnostics: 'build:diagnostics',
  usbFlashListPorts: 'usbflash:list-ports',
  usbFlashStart: 'usbflash:start',
  usbFlashCancel: 'usbflash:cancel',
  usbFlashState: 'usbflash:state',
  usbFlashOutput: 'usbflash:output',
  deviceSnapshot: 'device:snapshot',
  deviceEvent: 'device:event',
  deviceDiagnostic: 'device:diagnostic',
  deviceFramebuffer: 'device:framebuffer',
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

export type BoardSaveResult = { id: string } | { error: string }

/**
 * Everything `Root` needs before first paint now that there is no `.pinbench`
 * document: which hardware profile to load, which source folder to reopen (with
 * its PlatformIO envs already resolved), and the env + Inspector config last
 * used for that (folder, profile) pair.
 */
export interface LaunchState {
  /** Hardware profile id to load, or null to take the workbench default. */
  lastBoardId: string | null
  /** The reopened source folder, or null when there is none / it is gone. */
  folder: OpenProjectResult | null
  /** Remembered build env for (folder, lastBoardId), or null. */
  env: string | null
  /** Remembered `${partId}.${fieldId}` → value for (folder, lastBoardId). */
  partConfig: Record<string, PartConfigValue>
}

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
  /**
   * Canvas edits to fold into the board before generating the pin-map header
   * that Build & flash writes into the checkout. Empty / omitted → the pristine
   * board's header.
   */
  boardEdits?: BoardEdit[]
}

export interface UsbFlashRequest {
  projectDir: string
  env: string
  /** Serial port to write, from `usbFlash.listPorts()`. */
  port: string
  /** `flash` writes the app regions; `erase-flash` wipes the chip first. */
  mode: UsbFlashMode
  /** esptool `--chip`; taken from the board's `emulator.machine`. */
  chip?: string
}

export interface PinBenchApi {
  appInfo(): Promise<AppInfo>
  /** Resolved once by `Root` before the window paints. */
  launchState(): Promise<LaunchState>
  workspace: {
    load(): Promise<WorkspaceState>
    save(state: WorkspaceState): void
  }
  board: {
    /** Load and validate a board definition by id; the host also feeds it to the device host. */
    load(id?: string): Promise<BoardLoadResult>
    /** Board ids available on disk, sorted — for the board picker. */
    list(): Promise<string[]>
    /**
     * Write `def` as `boards/<id>.board.json` (validated first) — how a user
     * turns canvas edits into a shareable hardware profile. Resolves to the
     * saved id, or an error message.
     */
    saveProfile(id: string, def: BoardDefinition): Promise<BoardSaveResult>
    /** Remember `id` as the hardware profile to reopen with next launch. */
    remember(id: string): void
    /**
     * Write the pin-map C header for the loaded board to a path the user picks.
     * `edits` are the canvas edits to fold in first (empty for the pristine
     * board). Resolves to the written path, or null if the dialog was cancelled.
     */
    exportPinHeader(edits?: BoardEdit[]): Promise<string | null>
    /**
     * Prompt for a `.h` pin-map file and return its text, for the renderer to
     * fold back into the board as `rebindPin` edits. Null if cancelled.
     */
    importPinHeader(): Promise<string | null>
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
    /**
     * Prompt for a firmware source folder (must hold `platformio.ini`), adopt
     * it, and record it as the most-recently-opened folder. `envs` is resolved
     * through `extra_configs`, so variant build envs are included.
     */
    open(): Promise<OpenProjectResult | null>
    /** Immediate children of `dir`, or of the project root when omitted. */
    readTree(dir?: string): Promise<FileNode[]>
    readFile(path: string): Promise<string>
    onFileChanged(listener: (payload: { path: string }) => void): () => void
    /** Remember the build env + Inspector config for this (folder, profile) pair. */
    setFolderState(
      dir: string,
      boardId: string,
      state: { env: string | null; partConfig: Record<string, PartConfigValue> }
    ): void
  }
  build: {
    start(request: BuildRequest): void
    cancel(): void
    clean(projectDir: string): void
    onState(listener: (status: BuildStatus) => void): () => void
    onOutput(listener: (line: BuildOutputLine) => void): () => void
    onDiagnostics(listener: (rows: Diagnostic[]) => void): () => void
  }
  /** Flash real hardware over USB — the one path that leaves the emulator. */
  usbFlash: {
    /** Serial ports `pio device list` can see right now. */
    listPorts(): Promise<SerialPortInfo[]>
    /** Rebuild the env board-native (no emulator override), then esptool it. */
    start(request: UsbFlashRequest): void
    cancel(): void
    onState(listener: (status: UsbFlashStatus) => void): () => void
    onOutput(listener: (line: BuildOutputLine) => void): () => void
  }
  devices: {
    /** A device model's observable state changed. */
    onSnapshot(listener: (message: DeviceSnapshotMessage) => void): () => void
    /** A device model appended a row to its OUT-panel event log. */
    onEvent(listener: (message: DeviceEventMessage) => void): () => void
    /** A device model raised a diagnostic (unimplemented op, quarantine, …). */
    onDiagnostic(listener: (row: Diagnostic) => void): () => void
    /** A display model produced a new framebuffer (M6). Off the snapshot path. */
    onFramebuffer(listener: (message: DeviceFramebufferMessage) => void): () => void
    /** Send a command from an IN panel to a device model (wired from M7/M8). */
    command(message: DeviceCommandMessage): void
  }
}
