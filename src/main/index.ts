import { globSync } from 'node:fs'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type {
  AgentBridgeState,
  AgentPermissionDecision,
  AgentPermissionRequest,
  AppInfo,
  BoardLoadResult,
  BoardSaveResult,
  BuildRequest,
  LaunchState,
  OpenProjectAtResult,
  OpenProjectResult,
  UsbFlashRequest,
  WindowState
} from '../shared/ipc'
import type { PartConfigValue } from '../shared/partConfig'
import { DEFAULT_LAUNCH_OPTIONS, type EmulatorLaunchOptions } from '../shared/emulator'
import type { BoardDefinition } from '../shared/board'
import type { CommandId } from '../shared/commands'
import { acpRequested, startAcpBridge, type AcpBridge } from './acp/bridge'
import { agentCommandFromEnv } from './acp/agent'
import { normaliseWorkspace } from '../shared/workspace'
import { buildApplicationMenu } from './menu'
import { isBuildRunning } from '../shared/build'
import { isUsbFlashRunning } from '../shared/usb-flash'
import { collectEnvNames } from '../shared/pio'
import { availableBoardIds, loadBoard, saveBoardProfile } from './board'
import { generatePinHeader } from '../shared/codegen'
import { collectActions, renderActionsMarkdown, type FirmwareAction } from '../shared/actions'
import type { Diagnostic } from '../shared/diagnostics'
import { applyEdit, type BoardEdit } from '../shared/boardEdit'
import { BuildRunner } from './build'
import { UsbFlashRunner } from './usb-flash'
import { DeviceHost } from './devices'
import { EmulatorSupervisor } from './emulator'
import { probeCompanionIdentity } from './mesh-companion'
import { ProjectFiles, isInside } from './projectFiles'
import { adoptLoginShellPath } from './shellPath'
import { showSplash, type Splash } from './splash'
import { SessionStore, normaliseBoardEdits } from './store'

const isDev = !app.isPackaged

// Identify the app to the OS as early as possible — before the first window, the
// menu, or any Windows shell registration — so nothing surfaces as "electron".
export const APP_NAME = 'PinBench'
app.setName(APP_NAME)
process.title = APP_NAME
if (process.platform === 'win32') app.setAppUserModelId('com.pinbench.app')
// Launched from Finder/Dock, the app inherits launchd's bare PATH — no `pio`.
if (app.isPackaged) adoptLoginShellPath()

let mainWindow: BrowserWindow | null = null
let store: SessionStore | null = null
let emulator: EmulatorSupervisor | null = null
let build: BuildRunner | null = null
let usbFlash: UsbFlashRunner | null = null
let devices: DeviceHost | null = null
let project: ProjectFiles | null = null
/** Error/warning rows from the current (or last) build — input to the actions feed. */
let lastBuildDiagnostics: Diagnostic[] = []
/** Last board the renderer asked to load — the agent bridge's board authority (ADR 0002). */
let currentBoard: BoardDefinition | null = null
let acpBridge: AcpBridge | null = null
/** "Auto-approve agent actions" — skips the ACP permission prompts. Toggled from the Agent menu or prompt dialogs. */
let acpAutoApprove = process.env['PINBENCH_ACP_AUTO_APPROVE'] === '1'
let acpSessionAutoApprove = false
/** True once the ACP handshake has settled with a live session. */
let agentReady = false
/** True while a prompt turn is running. */
let agentBusy = false
/** True while the dock's Agent panel is mounted — routes permission prompts inline. */
let agentPanelPresent = false
/** Raw `session/update` payloads buffered for a panel that mounts mid-turn. */
const agentUpdateRing: unknown[] = []
const AGENT_UPDATE_RING_MAX = 500
/** Pending inline approvals, keyed by the id sent to the renderer. */
const pendingAgentPermissions = new Map<
  string,
  (decision: AgentPermissionDecision, optionId?: string) => void
>()
let agentPermissionSeq = 0

/** Snapshot for `agent.state()` and every `agent:state` push. */
function agentBridgeState(): AgentBridgeState {
  return {
    enabled: acpBridge !== null,
    agentConfigured: agentCommandFromEnv() !== null,
    ready: agentReady,
    busy: agentBusy,
    autoApprove: acpAutoApprove || acpSessionAutoApprove
  }
}

function pushAgentState(): void {
  mainWindow?.webContents.send(IpcChannel.agentState, agentBridgeState())
}

/**
 * Forget the renderer's Agent panel and refuse every approval it still owes.
 * Called when the window reloads or closes — the React cleanup that would clear
 * `agentPanelPresent` never runs on a hard reload, so a stale `true` would send
 * the next `exec` prompt to a webContents that can no longer answer it, hanging
 * the agent turn with no visible cause.
 */
function resetAgentPanelState(): void {
  agentPanelPresent = false
  for (const resolve of pendingAgentPermissions.values()) resolve('deny')
  pendingAgentPermissions.clear()
}

/** Pick the option an "allow" decision maps to — allow_always ▸ allow_once ▸ /allow/i ▸ first. */
function pickAllowOption<T extends { optionId: string; kind?: string }>(
  options: readonly T[]
): T | undefined {
  return (
    options.find((o) => o.kind === 'allow_always') ??
    options.find((o) => o.kind === 'allow_once') ??
    options.find((o) => /allow/i.test(o.optionId)) ??
    options[0]
  )
}

/**
 * Apply a `session` / `always` widening decision to the auto-approve state and
 * resync the menu + panel. `once` / `deny` are no-ops here.
 */
function widenAutoApprove(decision: AgentPermissionDecision): void {
  if (decision === 'session') acpSessionAutoApprove = true
  else if (decision === 'always') {
    acpAutoApprove = true
    session().setAcpAutoApprove(true)
  } else return
  refreshMenu()
  pushAgentState()
}

/**
 * Ask the renderer's Agent panel to approve something. Resolves with the user's
 * decision, or `null` when no panel is mounted — the caller then falls back to
 * the native `dialog.showMessageBox` path (M16.4: inline prompts are a second
 * surface, never the only one).
 */
function askAgentPermissionInline(
  request: Omit<AgentPermissionRequest, 'id'>
): Promise<{ decision: AgentPermissionDecision; optionId?: string } | null> {
  if (!agentPanelPresent || !mainWindow) return Promise.resolve(null)
  const id = `perm-${++agentPermissionSeq}`
  return new Promise((resolve) => {
    pendingAgentPermissions.set(id, (decision, optionId) =>
      resolve(optionId === undefined ? { decision } : { decision, optionId })
    )
    mainWindow?.webContents.send(IpcChannel.agentPermissionRequest, {
      id,
      ...request
    } satisfies AgentPermissionRequest)
  })
}

const cacheDir = (): string => join(app.getPath('userData'), 'build-cache')

/** `currentBoard` with the renderer's canvas edits folded in, stale edits skipped. */
function boardWithEdits(edits: BoardEdit[] | undefined): BoardDefinition | null {
  let board = currentBoard
  if (!board) return null
  for (const edit of Array.isArray(edits) ? edits : []) {
    try {
      board = applyEdit(board, edit)
    } catch {
      /* a stale edit — skip it, same as the renderer's replay */
    }
  }
  return board
}

const builder = (): BuildRunner => {
  if (!build) {
    build = new BuildRunner({ cacheDir: cacheDir(), userDataDir: app.getPath('userData') })
    build.on('state', (status) => {
      mainWindow?.webContents.send(IpcChannel.buildState, status)
      if (status.state === 'preparing') lastBuildDiagnostics = []
      if (status.state === 'done' || status.state === 'failed') void refreshActions()
    })
    build.on('output', (line) => mainWindow?.webContents.send(IpcChannel.buildOutput, line))
    build.on('diagnostics', (rows) => {
      lastBuildDiagnostics = [...lastBuildDiagnostics, ...rows]
      mainWindow?.webContents.send(IpcChannel.buildDiagnostics, rows)
    })
  }
  return build
}

const flasher = (): UsbFlashRunner => {
  if (!usbFlash) {
    usbFlash = new UsbFlashRunner({
      userDataDir: app.getPath('userData'),
      cacheDir: cacheDir()
    })
    usbFlash.on('state', (status) => mainWindow?.webContents.send(IpcChannel.usbFlashState, status))
    usbFlash.on('output', (line) => mainWindow?.webContents.send(IpcChannel.usbFlashOutput, line))
  }
  return usbFlash
}

const session = (): SessionStore => {
  store ??= new SessionStore()
  return store
}

/** Where the QEMU bus controllers (M6, in the fork) connect to reach the TS models. */
const deviceSocketPath = (): string => join(app.getPath('userData'), 'pinbench-devices.sock')
const uart1SocketPath = (): string => join(app.getPath('userData'), 'pinbench-uart1.sock')

/**
 * Cached MeshCore companion identity key (hex) for `direct` injection. A probe
 * triggers a self-advert on the modelled radio and reads the guest's key off
 * it — see {@link probeCompanionIdentity}. Reset whenever the emulator stops or
 * restarts (a rebuilt image is a different node).
 */
let meshDirectKey: string | null = null
let meshDirectKeyProbe: Promise<string | null> | null = null

const resolveMeshDirectKey = (): Promise<string | null> => {
  if (meshDirectKey) return Promise.resolve(meshDirectKey)
  if (meshDirectKeyProbe) return meshDirectKeyProbe
  if (emulator?.getStatus().state !== 'running') return Promise.resolve(null)
  const host = deviceHost()
  meshDirectKeyProbe = probeCompanionIdentity(
    {
      writeSerialBytes: (bytes) => emu().writeSerialBytes(bytes),
      onDeviceEvent: (listener) => {
        host.on('event', listener)
        return () => host.off('event', listener)
      }
    },
    // A real ESP32-S3 MeshCore boot to app-protocol-ready is ~15-25 s and slower
    // under load; keep re-triggering the self-advert for ~40 s before giving up.
    { attempts: 20, attemptGapMs: 2000 }
  )
    .then((key) => {
      meshDirectKey = key
      if (key) mainWindow?.webContents.send(IpcChannel.meshIdentity, key)
      return key
    })
    .finally(() => {
      meshDirectKeyProbe = null
    })
  return meshDirectKeyProbe
}

const deviceHost = (): DeviceHost => {
  if (!devices) {
    devices = new DeviceHost()
    devices.setMeshDirectKeyResolver(resolveMeshDirectKey)
    devices.on('snapshot', (message) =>
      mainWindow?.webContents.send(IpcChannel.deviceSnapshot, message)
    )
    devices.on('event', (message) => mainWindow?.webContents.send(IpcChannel.deviceEvent, message))
    devices.on('diagnostic', (row) =>
      mainWindow?.webContents.send(IpcChannel.deviceDiagnostic, row)
    )
    devices.on('framebuffer', (message) =>
      mainWindow?.webContents.send(IpcChannel.deviceFramebuffer, message)
    )
    // Start listening now, before any emulator spawns — the guest's SPI
    // controller connects during QEMU realize and blocks the vCPU on the reply.
    devices.listen(deviceSocketPath()).catch((error) => {
      mainWindow?.webContents.send(IpcChannel.deviceDiagnostic, {
        id: 'device-listen',
        severity: 'warn',
        message: `device host socket unavailable: ${(error as Error).message} — TS device models will not receive guest traffic`
      })
    })
    devices.listenUart(1, uart1SocketPath()).catch((error) => {
      mainWindow?.webContents.send(IpcChannel.deviceDiagnostic, {
        id: 'device-listen-uart1',
        severity: 'warn',
        message: `UART1 bridge unavailable: ${(error as Error).message} — a UART1 device model will not hear the guest`
      })
    })
  }
  return devices
}

const emu = (): EmulatorSupervisor => {
  if (!emulator) {
    emulator = new EmulatorSupervisor()
    emulator.on('status', (status) => {
      // A stopped / restarting emulator invalidates the learned identity key.
      if (status.state !== 'running') {
        meshDirectKey = null
        meshDirectKeyProbe = null
      }
      mainWindow?.webContents.send(IpcChannel.emulatorStatus, status)
    })
    emulator.on('serial', (lines) => {
      mainWindow?.webContents.send(IpcChannel.serialData, lines)
    })
  }
  return emulator
}

function windowState(window: BrowserWindow): WindowState {
  return {
    maximised: window.isMaximized(),
    fullScreen: window.isFullScreen(),
    focused: window.isFocused()
  }
}

function persistBounds(window: BrowserWindow): void {
  if (window.isMinimized() || window.isFullScreen()) return
  const { x, y, width, height } = window.getNormalBounds()
  session().setWindow({ x, y, width, height, maximised: window.isMaximized() })
}

function createWindow(splash?: Splash): BrowserWindow {
  const saved = session().get().window

  const window = new BrowserWindow({
    title: APP_NAME,
    width: saved.width,
    height: saved.height,
    ...(saved.x === undefined || saved.y === undefined ? {} : { x: saved.x, y: saved.y }),
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#161826',
    frame: false,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 13 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false
    }
  })

  if (saved.maximised) window.maximize()

  window.once('ready-to-show', () => (splash ? splash.handOff(window) : window.show()))

  const broadcastState = (): void => {
    if (!window.isDestroyed()) window.webContents.send(IpcChannel.windowState, windowState(window))
  }
  window.on('maximize', broadcastState)
  window.on('unmaximize', broadcastState)
  window.on('enter-full-screen', broadcastState)
  window.on('leave-full-screen', broadcastState)
  window.on('focus', broadcastState)
  // Coming back from the IDE is when the firmware has most likely changed.
  window.on('focus', scheduleActionsRefresh)
  window.on('blur', broadcastState)

  let boundsTimer: NodeJS.Timeout | null = null
  const scheduleBoundsSave = (): void => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => persistBounds(window), 250)
  }
  window.on('resize', scheduleBoundsSave)
  window.on('move', scheduleBoundsSave)
  window.on('close', () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    persistBounds(window)
  })

  // A hard reload / reopen skips React's cleanup — drop stale ACP panel state
  // so pending approvals fall back to the native dialog instead of hanging.
  window.webContents.on('did-start-loading', resetAgentPanelState)
  window.on('closed', resetAgentPanelState)

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url)
    const devServer = process.env['ELECTRON_RENDERER_URL']
    if (devServer && url.startsWith(devServer)) return
    event.preventDefault()
    if (target.protocol === 'http:' || target.protocol === 'https:') void shell.openExternal(url)
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devServerUrl) void window.loadURL(devServerUrl)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))

  return window
}

function registerIpc(): void {
  ipcMain.handle(IpcChannel.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    isDev
  }))

  // What `Root` needs before first paint now that there is no `.pinbench` file:
  // the last hardware profile, the last source folder (re-adopted here so the
  // Source tree and Build & flash come back with it), and the env + Inspector
  // config last used for that pair.
  ipcMain.handle(IpcChannel.appLaunchState, (): LaunchState => {
    const s = session()
    const lastBoardId = s.get().lastBoardId
    const dir = s.lastFolder()
    let folder: OpenProjectResult | null = null
    if (dir && existsSync(join(dir, 'platformio.ini'))) {
      try {
        folder = openProject(dir)
      } catch {
        folder = null
      }
    }
    const remembered = folder && lastBoardId ? s.folderState(folder.dir, lastBoardId) : null
    // Only offer recents that still have a platformio.ini — a moved or deleted
    // checkout should not sit in the dropdown as a dead entry.
    const recentFolders = s.get().recentFolders.filter((p) => existsSync(join(p, 'platformio.ini')))
    return {
      lastBoardId,
      folder,
      recentFolders,
      env: remembered?.env ?? null,
      partConfig: remembered?.partConfig ?? {},
      boardEdits: remembered?.boardEdits ?? []
    }
  })

  ipcMain.handle(IpcChannel.workspaceLoad, () => session().get().workspace)

  ipcMain.on(IpcChannel.workspaceSave, (_event, state: unknown) => {
    session().setWorkspace(normaliseWorkspace(state))
  })

  ipcMain.on(IpcChannel.windowMinimise, (event) =>
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  )
  ipcMain.on(IpcChannel.windowToggleMaximise, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  ipcMain.on(IpcChannel.windowClose, (event) =>
    BrowserWindow.fromWebContents(event.sender)?.close()
  )

  ipcMain.handle(IpcChannel.emulatorOpenFirmware, async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open firmware flash image',
      filters: [
        { name: 'Flash image', extensions: ['bin'] },
        { name: 'All files', extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.on(
    IpcChannel.emulatorStart,
    (_event, firmwarePath: string, options?: EmulatorLaunchOptions) => {
      // Ensure the device host is listening before QEMU spawns — its SPI
      // controllers connect during realize and block on the first reply.
      deviceHost()
      emu().setDeviceSocket(deviceSocketPath())
      emu().setUart1Socket(deviceHost().hasUartPart(1) ? uart1SocketPath() : null)
      emu().start(firmwarePath, options)
    }
  )

  ipcMain.on(IpcChannel.emulatorStop, () => {
    emu().stop()
  })

  ipcMain.on(IpcChannel.emulatorReset, () => {
    emu().reset()
  })

  ipcMain.on(IpcChannel.serialWrite, (_event, text: string) => {
    emu().writeSerial(text)
  })

  ipcMain.handle(IpcChannel.boardLoad, (_event, id?: string): BoardLoadResult => {
    // The board is read and validated here, in the main process — the sandboxed
    // renderer has no filesystem, and reading it here lets the device host take
    // the parsed definition directly rather than trusting a renderer round trip.
    try {
      const board = loadBoard(typeof id === 'string' && id ? id : undefined)
      deviceHost().load(board)
      currentBoard = board
      scheduleActionsRefresh()
      return { board }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(IpcChannel.boardList, (): string[] => availableBoardIds())

  // Turn the current (edited) board into a shareable hardware profile on disk.
  // If it overwrites the loaded board, refresh the in-memory authority and the
  // device host so the canvas and models do not drift from the file.
  ipcMain.handle(
    IpcChannel.boardSaveProfile,
    (_event, id: string, definition: unknown): BoardSaveResult => {
      try {
        const saved = saveBoardProfile(id, definition)
        if (currentBoard?.id === saved.id) {
          currentBoard = saved
          deviceHost().load(saved)
        }
        return { id: saved.id }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  ipcMain.on(IpcChannel.boardRemember, (_event, id: unknown) => {
    if (typeof id === 'string' && id) session().setLastBoard(id)
  })

  ipcMain.on(
    IpcChannel.projectSetFolderState,
    (_event, dir: unknown, boardId: unknown, state: unknown) => {
      if (typeof dir !== 'string' || typeof boardId !== 'string' || !dir || !boardId) return
      const raw = (state ?? {}) as {
        env?: unknown
        partConfig?: unknown
        boardEdits?: unknown
      }
      // A patch: only carry the fields the renderer actually sent, so persisting
      // a canvas layout can't wipe the remembered env / Inspector config.
      const patch: Parameters<SessionStore['setFolderState']>[2] = {}
      if ('env' in raw) patch.env = typeof raw.env === 'string' ? raw.env : null
      if (raw.partConfig && typeof raw.partConfig === 'object') {
        const partConfig: Record<string, PartConfigValue> = {}
        for (const [k, v] of Object.entries(raw.partConfig as Record<string, unknown>)) {
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
            partConfig[k] = v
          }
        }
        patch.partConfig = partConfig
      }
      if ('boardEdits' in raw) patch.boardEdits = normaliseBoardEdits(raw.boardEdits)
      session().setFolderState(resolve(dir), boardId, patch)
      if ('boardEdits' in raw || 'env' in raw) scheduleActionsRefresh()
    }
  )

  ipcMain.handle(
    IpcChannel.exportPinHeader,
    async (_event, edits?: BoardEdit[]): Promise<string | null> => {
      const board = boardWithEdits(edits)
      if (!mainWindow || !board) return null
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Export pin header',
        defaultPath: `board_${board.id}.h`,
        filters: [{ name: 'C header', extensions: ['h'] }]
      })
      if (result.canceled || !result.filePath) return null
      await writeFile(result.filePath, generatePinHeader(board), 'utf8')
      return result.filePath
    }
  )

  ipcMain.handle(IpcChannel.importPinHeader, async (): Promise<string | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import pin header',
      filters: [{ name: 'C header', extensions: ['h'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    try {
      return readFileSync(result.filePaths[0]!, 'utf8')
    } catch (error) {
      return `/* import failed: ${String(error)} */`
    }
  })

  ipcMain.on(
    IpcChannel.deviceCommand,
    (_event, message: { partId: string; command: string; args?: Record<string, unknown> }) => {
      if (message.command === 'signal' && typeof message.args?.['level'] === 'number') {
        const level = message.args['level'] === 0 ? 0 : 1
        const signal = String(message.args['signal'] ?? 'ANODE')
        devices?.injectSignal(message.partId, signal, level)
      } else {
        // Any other command (LR1110 IN panel: `inject`, `setParam`) goes
        // straight to the model's onCommand.
        devices?.command(message.partId, message.command, message.args)
      }
    }
  )

  ipcMain.handle(IpcChannel.projectOpen, async (): Promise<OpenProjectResult | null> => {
    if (!mainWindow) return null
    const busy =
      (build && isBuildRunning(build.getStatus().state)) ||
      (usbFlash && isUsbFlashRunning(usbFlash.getStatus().state))
    if (busy) {
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        message: 'A build or flash is still running',
        detail: 'Wait for it to finish or cancel it before opening another project.'
      })
      return null
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open firmware project',
      message: 'Choose a PlatformIO project folder (contains platformio.ini)',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const dir = result.filePaths[0]!
    if (!existsSync(join(dir, 'platformio.ini'))) {
      await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        message: 'No platformio.ini in that folder',
        detail: 'Pick the project root — the directory that holds platformio.ini.'
      })
      return null
    }
    const opened = openProject(dir)
    session().addRecentFolder(opened.dir)
    return opened
  })

  ipcMain.handle(
    IpcChannel.projectOpenAt,
    async (_event, rawDir: unknown): Promise<OpenProjectAtResult> => {
      if (typeof rawDir !== 'string' || rawDir.length === 0) {
        return { error: 'no folder path given' }
      }
      const busy =
        (build && isBuildRunning(build.getStatus().state)) ||
        (usbFlash && isUsbFlashRunning(usbFlash.getStatus().state))
      if (busy) return { error: 'a build or flash is still running' }
      const dir = resolve(rawDir)
      if (!existsSync(join(dir, 'platformio.ini'))) {
        return { error: `no platformio.ini in ${dir}` }
      }
      const opened = openProject(dir)
      session().addRecentFolder(opened.dir)
      return opened
    }
  )

  ipcMain.handle(IpcChannel.projectActions, (): Promise<FirmwareAction[]> => refreshActions())

  ipcMain.handle(
    IpcChannel.projectOpenInEditor,
    async (_event, file: unknown, line: unknown, column: unknown): Promise<void> => {
      if (!project || typeof file !== 'string' || file.length === 0) return
      const abs = resolve(project.rootDir, file)
      // Only files in the open project — a diagnostic can name a toolchain
      // header, and the bridge must not become a generic URL launcher.
      if (!isInside(project.rootDir, abs)) return
      await shell.openExternal(
        editorUrl(
          session().get().editorUrl,
          abs,
          typeof line === 'number' ? line : undefined,
          typeof column === 'number' ? column : undefined
        )
      )
    }
  )

  ipcMain.on(IpcChannel.buildStart, (_event, request: BuildRequest) => {
    // The renderer can only build the project the main process actually opened;
    // an arbitrary path off the bridge is refused, the way file reads are.
    if (!isOpenProject(request.projectDir)) return
    void builder()
      .run({
        projectDir: request.projectDir,
        env: request.env,
        emulator: request.emulator
      })
      .catch((error: unknown) => {
        mainWindow?.webContents.send(IpcChannel.buildState, {
          state: 'failed',
          error: String(error)
        })
      })
  })

  ipcMain.on(IpcChannel.buildCancel, () => build?.cancel())

  ipcMain.handle(IpcChannel.usbFlashListPorts, () => flasher().listPorts())

  ipcMain.on(IpcChannel.usbFlashStart, (_event, request: UsbFlashRequest) => {
    if (!isOpenProject(request.projectDir)) return
    if (request.mode !== 'flash' && request.mode !== 'erase-flash') return
    if (typeof request.port !== 'string' || request.port.length === 0) return
    void flasher()
      .run(request)
      .catch((error: unknown) => {
        mainWindow?.webContents.send(IpcChannel.usbFlashState, {
          state: 'failed',
          error: String(error)
        })
      })
  })

  ipcMain.on(IpcChannel.usbFlashCancel, () => usbFlash?.cancel())

  ipcMain.on(IpcChannel.buildClean, (_event, projectDir: string) => {
    if (!isOpenProject(projectDir)) return
    if (usbFlash && isUsbFlashRunning(usbFlash.getStatus().state)) {
      mainWindow?.webContents.send(IpcChannel.buildDiagnostics, [
        {
          id: 'clean',
          severity: 'warn',
          message: 'A USB flash is running — not clearing the cache'
        }
      ])
      return
    }
    try {
      rmSync(join(projectDir, '.pio', 'build'), { recursive: true, force: true })
      rmSync(cacheDir(), { recursive: true, force: true })
      mainWindow?.webContents.send(IpcChannel.buildDiagnostics, [
        { id: 'clean', severity: 'ok', message: 'Build cache cleared' }
      ])
    } catch (error) {
      mainWindow?.webContents.send(IpcChannel.buildState, { state: 'failed', error: String(error) })
    }
  })

  // ── Agent control plane (ACP) — the dock panel, M16.4 ──────────────────────
  ipcMain.handle(IpcChannel.agentState, (): AgentBridgeState => agentBridgeState())

  ipcMain.handle(IpcChannel.agentBacklog, (): unknown[] => agentUpdateRing.slice())

  ipcMain.handle(
    IpcChannel.agentPrompt,
    async (_event, text: unknown): Promise<{ stopReason: string } | { error: string }> => {
      if (!acpBridge) return { error: 'the agent bridge is not running' }
      // A fresh turn — drop the previous turn's buffered updates so a panel that
      // mounts mid-turn replays only this one.
      agentUpdateRing.length = 0
      agentBusy = true
      pushAgentState()
      try {
        return await acpBridge.prompt(String(text ?? ''))
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      } finally {
        agentBusy = false
        pushAgentState()
      }
    }
  )

  ipcMain.on(IpcChannel.agentCancel, () => acpBridge?.session?.cancel())

  ipcMain.on(IpcChannel.agentSetAutoApprove, (_event, on: unknown) => {
    const next = on === true
    acpAutoApprove = next
    acpSessionAutoApprove = next
    session().setAcpAutoApprove(next)
    refreshMenu()
    pushAgentState()
  })

  ipcMain.on(IpcChannel.agentPanelPresent, (_event, present: unknown) => {
    agentPanelPresent = present === true
  })

  ipcMain.on(
    IpcChannel.agentPermissionResolve,
    (_event, id: unknown, decision: unknown, optionId: unknown) => {
      const pending = pendingAgentPermissions.get(String(id))
      if (!pending) return
      pendingAgentPermissions.delete(String(id))
      const choice: AgentPermissionDecision =
        decision === 'session' || decision === 'always' || decision === 'deny' ? decision : 'once'
      pending(choice, typeof optionId === 'string' ? optionId : undefined)
    }
  )
}

/** True only for the exact directory the current project was opened from. */
function isOpenProject(dir: unknown): dir is string {
  return typeof dir === 'string' && project !== null && resolve(dir) === project.rootDir
}

function openProject(rawDir: string): OpenProjectResult {
  const dir = resolve(rawDir)
  project = new ProjectFiles(dir)
  lastBuildDiagnostics = []
  scheduleActionsRefresh()
  const envs = readEnvNames(dir)
  return { dir, name: basename(dir), envs }
}

// ── Required firmware actions — the feedback channel to the external IDE ─────
// PinBench never edits the firmware; what the simulated hardware needs from it
// is computed here (shared/actions.ts) and mirrored three ways: the renderer's
// Actions dock tab, the `firmware_actions` MCP tool, and `.pinbench/actions.md`
// in the project for agents without MCP.

const DEFAULT_EDITOR_URL = 'vscode://file{path}:{line}:{column}'

/**
 * The URL that opens `abs` in the external editor. `template` (session.json
 * `editorUrl`, else `PINBENCH_EDITOR_URL`) takes `{path}`, `{line}`, `{column}`;
 * `{path}` always starts with `/` (a drive path gets one prepended).
 */
function editorUrl(
  template: string | undefined,
  abs: string,
  line: number | undefined,
  column: number | undefined
): string {
  let path = abs.split('\\').join('/')
  if (!path.startsWith('/')) path = `/${path}`
  return (template ?? process.env['PINBENCH_EDITOR_URL'] ?? DEFAULT_EDITOR_URL)
    .replaceAll('{path}', encodeURI(path))
    .replaceAll('{line}', String(line ?? 1))
    .replaceAll('{column}', String(column ?? 1))
}

/** The generated header's project-relative path for `boardId`. */
const pinHeaderPath = (boardId: string): string => `include/${boardId}_pins.h`

async function computeActions(): Promise<FirmwareAction[]> {
  if (!project || !currentBoard) return []
  const edits = session().folderState(project.rootDir, currentBoard.id)?.boardEdits
  const board = boardWithEdits(edits) ?? currentBoard
  const headerPath = pinHeaderPath(board.id)
  const headerName = `${board.id}_pins.h`
  // A failed scan must not hide build errors: degrade to "nothing referenced".
  const [refs, headerText] = await Promise.all([
    project.findReferences([headerName, 'PINBENCH_EMULATED_NET']).catch(() => new Set<string>()),
    project.readFileMaybe(headerPath).catch(() => null)
  ])
  return collectActions({
    board,
    headerPath,
    headerText,
    headerReferenced: refs.has(headerName),
    emulatedNetReferenced: refs.has('PINBENCH_EMULATED_NET'),
    buildDiagnostics: lastBuildDiagnostics,
    projectDir: project.rootDir
  })
}

/**
 * Mirror `actions` into `<root>/.pinbench/actions.md` — the only thing PinBench
 * writes into a firmware folder. The directory ignores itself (`.gitignore`
 * with `*`), so the project's own ignore file is never touched. Removed when
 * the list is empty; left alone when unchanged so IDE file watchers stay quiet.
 */
function writeActionsFile(root: string, actions: FirmwareAction[]): void {
  const dir = join(root, '.pinbench')
  const file = join(dir, 'actions.md')
  try {
    if (actions.length === 0) {
      rmSync(file, { force: true })
      return
    }
    const env = currentBoard ? session().folderState(root, currentBoard.id)?.env : null
    const text = renderActionsMarkdown(actions, {
      boardName: currentBoard?.name ?? 'unknown',
      env: env ?? null
    })
    if (existsSync(file) && readFileSync(file, 'utf8') === text) return
    mkdirSync(dir, { recursive: true })
    const ignore = join(dir, '.gitignore')
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
    writeFileSync(file, text)
  } catch {
    // A read-only checkout — the dock tab and the MCP tool still carry the list.
  }
}

let actionsChain: Promise<FirmwareAction[]> = Promise.resolve([])

/** Recompute, mirror and broadcast the actions. Serialised so mirrors land in order. */
function refreshActions(): Promise<FirmwareAction[]> {
  actionsChain = actionsChain.then(async () => {
    const root = project?.rootDir ?? null
    const actions = await computeActions().catch((): FirmwareAction[] => [])
    if (root && root === project?.rootDir) writeActionsFile(root, actions)
    mainWindow?.webContents.send(IpcChannel.projectActionsChanged, actions)
    return actions
  })
  return actionsChain
}

let actionsTimer: NodeJS.Timeout | null = null

/** {@link refreshActions}, coalesced — focus and edit bursts trigger one scan. */
function scheduleActionsRefresh(): void {
  if (actionsTimer) clearTimeout(actionsTimer)
  actionsTimer = setTimeout(() => {
    actionsTimer = null
    void refreshActions()
  }, 300)
}

function readEnvNames(dir: string): string[] {
  // Cheap and synchronous, and — unlike a bare read of the top-level file —
  // follows `extra_configs`, so a repo that keeps each board's build envs in
  // `variants/<name>/platformio.ini` (MeshCore) still populates the picker. The
  // build itself re-reads via `pio project config` for the real merge.
  try {
    return collectEnvNames(
      (relativePath) => {
        try {
          return readFileSync(join(dir, relativePath), 'utf8')
        } catch {
          return null
        }
      },
      (pattern) => {
        try {
          return globSync(pattern, { cwd: dir }).map((p) => p.split('\\').join('/'))
        } catch {
          return []
        }
      }
    )
  } catch {
    return []
  }
}

/** Adopt a PlatformIO project by path — the agent bridge's dialog-free `project_open`. */
function openProjectAt(rawDir: string): OpenProjectResult {
  const dir = resolve(rawDir)
  if (!existsSync(join(dir, 'platformio.ini'))) {
    throw new Error(`no platformio.ini in ${dir}`)
  }
  return openProject(dir)
}

const noProject = <T>(): Promise<T> => Promise.reject(new Error('no project open'))

/** Build & boot `env` for the open project — the agent bridge's `build_start`. */
function buildEnv(env: string): void {
  if (!project) throw new Error('no project open')
  const emulatorTarget = currentBoard?.emulator ?? DEFAULT_LAUNCH_OPTIONS
  void builder()
    .run({ projectDir: project.rootDir, env, emulator: emulatorTarget })
    .catch((error: unknown) => {
      mainWindow?.webContents.send(IpcChannel.buildState, { state: 'failed', error: String(error) })
    })
}

/**
 * Rebuild the native menu. When the app runs `--acp`, the menu carries an
 * "Agent ▸ Auto-approve agent actions" checkbox bound to {@link acpAutoApprove};
 * toggling it rebuilds so the checkmark tracks the state.
 */
function refreshMenu(): void {
  Menu.setApplicationMenu(
    buildApplicationMenu(
      () => mainWindow,
      acpRequested()
        ? {
            autoApprove: acpAutoApprove || acpSessionAutoApprove,
            onToggle: (next) => {
              acpAutoApprove = next
              acpSessionAutoApprove = next
              session().setAcpAutoApprove(next)
              refreshMenu()
              pushAgentState()
            }
          }
        : undefined
    )
  )
}

/**
 * Stand up the agent control plane (roadmap M16.2–M16.3). Opt-in: only when the
 * app was started `--acp` / `PINBENCH_ACP=1`. Prints the loopback MCP URL and
 * the per-session token to stderr. When `PINBENCH_AGENT_CMD` is set, also
 * spawns that agent and opens a session pointed at the control server.
 */
async function startAgentBridge(): Promise<void> {
  if (!acpRequested() && !isDev) return
  try {
    if (session().get().acpAutoApprove === true) {
      acpAutoApprove = true
    }
    acpBridge = await startAcpBridge({
      appVersion: app.getVersion(),
      platform: process.platform,
      isDev,
      emulator: {
        getStatus: () => emu().getStatus(),
        start: (firmwarePath) => {
          deviceHost()
          emu().setDeviceSocket(deviceSocketPath())
          emu().setUart1Socket(deviceHost().hasUartPart(1) ? uart1SocketPath() : null)
          emu().start(firmwarePath, currentBoard?.emulator)
        },
        lastFirmware: () => emu().lastFirmware(),
        reset: () => emu().reset(),
        stop: () => emu().stop(),
        writeSerial: (text) => emu().writeSerial(text),
        on: (event, listener) => emu().on(event, listener)
      },
      build: {
        getStatus: () => builder().getStatus(),
        start: (env) => buildEnv(env),
        cancel: () => builder().cancel()
      },
      devices: deviceHost(),
      getBoard: () => currentBoard,
      onBoardChanged: (board) => {
        currentBoard = board
        scheduleActionsRefresh()
      },
      project: {
        open: async (dir) => openProjectAt(dir),
        readFile: (path) => (project ? project.readFile(path) : noProject()),
        actions: () => refreshActions(),
        rootDir: () => project?.rootDir ?? null,
        clean: () => {
          if (!project) throw new Error('no project open')
          rmSync(join(project.rootDir, '.pio', 'build'), { recursive: true, force: true })
          rmSync(cacheDir(), { recursive: true, force: true })
        }
      },
      menuCommand: (command: CommandId) =>
        mainWindow?.webContents.send(IpcChannel.menuCommand, command),
      autoApprove: () => acpAutoApprove || acpSessionAutoApprove,
      confirm: async (op) => {
        if (!mainWindow) return false
        if (acpAutoApprove || acpSessionAutoApprove) return true
        // Prefer the dock panel's inline prompt; fall back to the native dialog
        // when no panel is mounted, so a headless / panel-less run never hangs.
        const inline = await askAgentPermissionInline({
          kind: 'exec',
          title: op.title,
          detail: `${op.summary}\n\nOperation: ${op.name} (${op.risk})`
        })
        if (inline) {
          widenAutoApprove(inline.decision)
          return inline.decision !== 'deny'
        }
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: 'question',
          buttons: ['Allow Once', 'Allow for Session', 'Always Allow', 'Deny'],
          defaultId: 0,
          cancelId: 3,
          message: `Agent request: ${op.title}`,
          detail: `${op.summary}\n\nOperation: ${op.name} (${op.risk})`
        })
        if (response === 0) return true
        if (response === 1) {
          widenAutoApprove('session')
          return true
        }
        if (response === 2) {
          widenAutoApprove('always')
          return true
        }
        return false
      },
      requestAgentPermission: async (params) => {
        const p = (params ?? {}) as {
          options?: { optionId: string; name: string; kind?: string }[]
          toolCall?: { title?: string }
        }
        if (!mainWindow || !p.options || p.options.length === 0) {
          return { outcome: { outcome: 'cancelled' } }
        }
        const selected = (
          optionId: string
        ): { outcome: { outcome: string; optionId?: string } } => ({
          outcome: { outcome: 'selected', optionId }
        })
        if (acpAutoApprove || acpSessionAutoApprove) {
          const allow = pickAllowOption(p.options)!
          return selected(allow.optionId)
        }
        const title = p.toolCall?.title ?? 'permission requested'
        const inline = await askAgentPermissionInline({ kind: 'tool', title, options: p.options })
        if (inline) {
          if (inline.optionId) return selected(inline.optionId)
          if (inline.decision === 'deny') return { outcome: { outcome: 'cancelled' } }
          widenAutoApprove(inline.decision)
          const allow = pickAllowOption(p.options)!
          return selected(allow.optionId)
        }
        const buttons = [
          ...p.options.map((o) => o.name),
          'Allow for Session',
          'Always Allow',
          'Cancel'
        ]
        const sessionIdx = p.options.length
        const alwaysIdx = p.options.length + 1
        const cancelIdx = p.options.length + 2

        const { response } = await dialog.showMessageBox(mainWindow, {
          type: 'question',
          buttons,
          defaultId: 0,
          cancelId: cancelIdx,
          message: `Agent tool call: ${title}`
        })
        if (response === sessionIdx) {
          widenAutoApprove('session')
          return selected(pickAllowOption(p.options)!.optionId)
        }
        if (response === alwaysIdx) {
          widenAutoApprove('always')
          return selected(pickAllowOption(p.options)!.optionId)
        }
        const picked = p.options[response]
        return picked ? selected(picked.optionId) : { outcome: { outcome: 'cancelled' } }
      },
      onAgentUpdate: (params) => {
        agentUpdateRing.push(params)
        if (agentUpdateRing.length > AGENT_UPDATE_RING_MAX) {
          agentUpdateRing.splice(0, agentUpdateRing.length - AGENT_UPDATE_RING_MAX)
        }
        mainWindow?.webContents.send(IpcChannel.agentUpdate, params)
        if (isDev) process.stderr.write(`[agent] update ${JSON.stringify(params)}\n`)
      }
    })
    void acpBridge.ready.then(() => {
      agentReady = acpBridge?.session != null
      pushAgentState()
    })
    pushAgentState()
    const acpInfo = JSON.stringify(
      {
        url: acpBridge.server.url,
        token: acpBridge.server.token,
        port: acpBridge.server.port
      },
      null,
      2
    )
    try {
      writeFileSync('/tmp/pinbench-acp.json', acpInfo, 'utf8')
    } catch {
      // ignore
    }
    process.stderr.write(
      `[pinbench] ACP control server on ${acpBridge.server.url}\n[pinbench] ACP token: ${acpBridge.server.token}\n`
    )
  } catch (error) {
    process.stderr.write(`[pinbench] ACP bridge failed to start: ${String(error)}\n`)
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: app.getVersion(),
      version: '',
      credits: 'A cross-platform desktop workbench for embedded mesh-radio boards.'
    })
    registerIpc()
    refreshMenu()
    const splash =
      process.env['PINBENCH_NO_SPLASH'] === '1'
        ? undefined
        : showSplash(join(app.getAppPath(), 'resources', 'splash'))
    mainWindow = createWindow(splash)
    void startAgentBridge()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  app.on('before-quit', () => {
    try {
      rmSync('/tmp/pinbench-acp.json', { force: true })
    } catch {
      // ignore
    }
    emulator?.dispose()
    build?.dispose()
    usbFlash?.dispose()
    void devices?.dispose()
    void acpBridge?.dispose()
    if (actionsTimer) clearTimeout(actionsTimer)
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
