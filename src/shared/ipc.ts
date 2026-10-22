import type { BuildOutputLine, BuildStatus } from './build'
import type { CommandId } from './commands'
import type { BoardDefinition } from './board'
import type { BoardEdit } from './boardEdit'
import type { PartConfigValue } from './partConfig'
import type {
  DeviceCommandMessage,
  DeviceEventMessage,
  DeviceFramebufferMessage,
  DeviceSnapshotMessage
} from './devices/messages'
import type { Diagnostic } from './diagnostics'
import type { EmulatorLaunchOptions, EmulatorStatus } from './emulator'
import type { FirmwareAction } from './actions'
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
  projectOpenAt: 'project:open-at',
  projectActions: 'project:actions',
  projectActionsChanged: 'project:actions-changed',
  projectOpenInEditor: 'project:open-in-editor',
  boardLoad: 'board:load',
  boardList: 'board:list',
  boardSaveProfile: 'board:save-profile',
  boardRemember: 'board:remember',
  exportPinHeader: 'board:export-pin-header',
  importPinHeader: 'board:import-pin-header',
  projectSetFolderState: 'project:set-folder-state',
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
  deviceCommand: 'device:command',
  /** main → renderer: the learned MeshCore companion identity key (hex). */
  meshIdentity: 'mesh:identity',
  /** The agent control plane (ACP) — M16.4 dock panel. */
  agentState: 'agent:state',
  agentBacklog: 'agent:backlog',
  agentUpdate: 'agent:update',
  agentPrompt: 'agent:prompt',
  agentCancel: 'agent:cancel',
  agentSetAutoApprove: 'agent:set-auto-approve',
  agentPanelPresent: 'agent:panel-present',
  agentPermissionRequest: 'agent:permission-request',
  agentPermissionResolve: 'agent:permission-resolve'
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

export type OpenProjectAtResult = OpenProjectResult | { error: string }

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
  /** Absolute paths of recently opened source folders, most recent first. */
  recentFolders: string[]
  /** Remembered build env for (folder, lastBoardId), or null. */
  env: string | null
  /** Remembered `${partId}.${fieldId}` → value for (folder, lastBoardId). */
  partConfig: Record<string, PartConfigValue>
  /** Remembered canvas edit history for (folder, lastBoardId); `[]` when none. */
  boardEdits: BoardEdit[]
}

/**
 * What the agent dock panel needs to render itself (M16.4). Pushed on every
 * change and returned by `agent.state()` on mount.
 */
export interface AgentBridgeState {
  /** The `--acp` bridge is running at all. Panel hides its controls when false. */
  enabled: boolean
  /** An agent subprocess was configured (`PINBENCH_AGENT_CMD`) and spawned. */
  agentConfigured: boolean
  /** The ACP handshake settled — `prompt` will work. */
  ready: boolean
  /** A prompt turn is running right now. */
  busy: boolean
  /** "Auto-approve agent actions" — `exec` ops and tool calls skip the prompt. */
  autoApprove: boolean
}

/** An approval the agent bridge is waiting on, surfaced inline in the panel. */
export interface AgentPermissionRequest {
  /** Correlates the renderer's `resolvePermission` back to the pending gate. */
  id: string
  /** `exec` = a typed PinBench operation gate; `tool` = an ACP `session/request_permission`. */
  kind: 'exec' | 'tool'
  title: string
  detail?: string
  /** For `tool`: the option buttons the agent offered. */
  options?: { optionId: string; name: string; kind?: string }[]
}

/**
 * The renderer's answer to an {@link AgentPermissionRequest}. `once` allows this
 * one; `session` / `always` also widen `autoApprove` for the rest of the
 * session / permanently; `deny` refuses. `optionId` picks a specific agent
 * option for a `tool` request instead of the inferred allow.
 */
export type AgentPermissionDecision = 'once' | 'session' | 'always' | 'deny'

export interface BuildRequest {
  projectDir: string
  env: string
  /** Emulator launch options for the board, forwarded to the merge/boot step. */
  emulator: EmulatorLaunchOptions
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
    /**
     * Adopt a known folder by path — no dialog. For the session bar's recents
     * dropdown. Reorders it to the front of the recent list. Resolves to an
     * `{ error }` when the path is gone or has no `platformio.ini`.
     */
    openAt(dir: string): Promise<OpenProjectAtResult>
    /**
     * Open a project file in the external editor (code lives there, not in
     * PinBench). `file` may be project-relative; paths outside the project are
     * ignored.
     */
    openInEditor(file: string, line?: number, column?: number): Promise<void>
    /** Recompute the required firmware changes now. */
    actions(): Promise<FirmwareAction[]>
    /** Fires whenever the main process recomputes the required firmware changes. */
    onActions(listener: (actions: FirmwareAction[]) => void): () => void
    /**
     * Merge a patch into the remembered build env + Inspector config + canvas
     * edits for this (folder, profile) pair. Omitted fields are left untouched.
     */
    setFolderState(
      dir: string,
      boardId: string,
      state: {
        env?: string | null
        partConfig?: Record<string, PartConfigValue>
        boardEdits?: BoardEdit[]
      }
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
  /**
   * The agent control plane (ACP + MCP), M16.4. Only live when PinBench was
   * started `--acp` / `PINBENCH_ACP=1`; otherwise `state()` reports
   * `enabled: false` and the panel renders an explanation.
   */
  agent: {
    /** Current bridge state — call on mount, then track via {@link onState}. */
    state(): Promise<AgentBridgeState>
    onState(listener: (state: AgentBridgeState) => void): () => void
    /** Raw `session/update` payloads buffered since the bridge started. */
    backlog(): Promise<unknown[]>
    /** One raw `session/update` payload — feed to `applySessionUpdate`. */
    onUpdate(listener: (params: unknown) => void): () => void
    /** Run a prompt turn. Resolves with the stop reason, or an `{ error }`. */
    prompt(text: string): Promise<{ stopReason: string } | { error: string }>
    /** Ask the agent to abort the running turn. */
    cancel(): void
    /** Flip the "auto-approve agent actions" switch. */
    setAutoApprove(on: boolean): void
    /** Tell main the panel mounted/unmounted — gates inline vs. native prompts. */
    setPanelPresent(present: boolean): void
    /** A pending approval to show inline. */
    onPermissionRequest(listener: (request: AgentPermissionRequest) => void): () => void
    /** Answer a pending {@link AgentPermissionRequest}. */
    resolvePermission(id: string, decision: AgentPermissionDecision, optionId?: string): void
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
    /** The learned MeshCore companion identity key (hex) — prefills "Recipient key". */
    onMeshIdentity(listener: (key: string) => void): () => void
    /** Send a command from an IN panel to a device model (wired from M7/M8). */
    command(message: DeviceCommandMessage): void
  }
}
