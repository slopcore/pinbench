import { watch, type FSWatcher } from 'node:fs'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type {
  AppInfo,
  BoardLoadResult,
  BuildRequest,
  OpenProjectResult,
  ProjectFileResult,
  ProjectSaveResult,
  WindowState
} from '../shared/ipc'
import type { EmulatorLaunchOptions } from '../shared/emulator'
import { normaliseWorkspace } from '../shared/workspace'
import { normaliseProject } from '../shared/project'
import { buildApplicationMenu } from './menu'
import { isBuildRunning } from '../shared/build'
import { parseEnvNamesFromIni } from '../shared/pio'
import { loadBoard } from './board'
import { readProjectFile, writeProjectFile } from './projectFile'
import { BuildRunner } from './build'
import { DeviceHost } from './devices'
import { EmulatorSupervisor } from './emulator'
import { ProjectFiles } from './fileTree'
import { SessionStore } from './store'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let store: SessionStore | null = null
let emulator: EmulatorSupervisor | null = null
let build: BuildRunner | null = null
let devices: DeviceHost | null = null
let project: ProjectFiles | null = null
let projectWatcher: FSWatcher | null = null

const cacheDir = (): string => join(app.getPath('userData'), 'build-cache')

const builder = (): BuildRunner => {
  if (!build) {
    build = new BuildRunner({ cacheDir: cacheDir(), userDataDir: app.getPath('userData') })
    build.on('state', (status) => mainWindow?.webContents.send(IpcChannel.buildState, status))
    build.on('output', (line) => mainWindow?.webContents.send(IpcChannel.buildOutput, line))
    build.on('diagnostics', (rows) =>
      mainWindow?.webContents.send(IpcChannel.buildDiagnostics, rows)
    )
  }
  return build
}

const session = (): SessionStore => {
  store ??= new SessionStore()
  return store
}

const deviceHost = (): DeviceHost => {
  if (!devices) {
    devices = new DeviceHost()
    devices.on('snapshot', (message) =>
      mainWindow?.webContents.send(IpcChannel.deviceSnapshot, message)
    )
    devices.on('event', (message) => mainWindow?.webContents.send(IpcChannel.deviceEvent, message))
    devices.on('diagnostic', (row) =>
      mainWindow?.webContents.send(IpcChannel.deviceDiagnostic, row)
    )
  }
  return devices
}

const emu = (): EmulatorSupervisor => {
  if (!emulator) {
    emulator = new EmulatorSupervisor()
    emulator.on('status', (status) => {
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

function createWindow(): BrowserWindow {
  const saved = session().get().window

  const window = new BrowserWindow({
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

  window.once('ready-to-show', () => window.show())

  const broadcastState = (): void => {
    if (!window.isDestroyed()) window.webContents.send(IpcChannel.windowState, windowState(window))
  }
  window.on('maximize', broadcastState)
  window.on('unmaximize', broadcastState)
  window.on('enter-full-screen', broadcastState)
  window.on('leave-full-screen', broadcastState)
  window.on('focus', broadcastState)
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
      return { board }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.on(
    IpcChannel.deviceCommand,
    (_event, message: { partId: string; command: string; args?: Record<string, unknown> }) => {
      if (message.command === 'signal' && typeof message.args?.['level'] === 'number') {
        const level = message.args['level'] === 0 ? 0 : 1
        const signal = String(message.args['signal'] ?? 'ANODE')
        devices?.injectSignal(message.partId, signal, level)
      }
    }
  )

  ipcMain.handle(IpcChannel.projectOpen, async (): Promise<OpenProjectResult | null> => {
    if (!mainWindow) return null
    if (build && isBuildRunning(build.getStatus().state)) {
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        message: 'A build is still running',
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
    return openProject(dir)
  })

  ipcMain.handle(IpcChannel.projectReadTree, (_event, dir?: string) =>
    project ? project.readTree(dir) : Promise.resolve([])
  )

  ipcMain.handle(IpcChannel.projectReadFile, (_event, path: string) =>
    project ? project.readFile(path) : Promise.resolve('')
  )

  ipcMain.on(IpcChannel.buildStart, (_event, request: BuildRequest) => {
    // The renderer can only build the project the main process actually opened;
    // an arbitrary path off the bridge is refused, the way file reads are.
    if (!isOpenProject(request.projectDir)) return
    void builder()
      .run({ projectDir: request.projectDir, env: request.env, emulator: request.emulator })
      .catch((error: unknown) => {
        mainWindow?.webContents.send(IpcChannel.buildState, {
          state: 'failed',
          error: String(error)
        })
      })
  })

  ipcMain.handle(IpcChannel.projectFileOpen, async (): Promise<ProjectFileResult | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open PinBench project',
      filters: [{ name: 'PinBench project', extensions: ['pinbench'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return adoptProjectFile(result.filePaths[0]!)
  })

  ipcMain.handle(
    IpcChannel.projectFileSave,
    async (_event, path: string | null, incoming: unknown): Promise<ProjectSaveResult> => {
      const projectFile = normaliseProject(incoming)
      let target = typeof path === 'string' && path ? path : null
      if (!target) {
        if (!mainWindow) return { canceled: true }
        const result = await dialog.showSaveDialog(mainWindow, {
          title: 'Save PinBench project',
          defaultPath: 'untitled.pinbench',
          filters: [{ name: 'PinBench project', extensions: ['pinbench'] }]
        })
        if (result.canceled || !result.filePath) return { canceled: true }
        target = result.filePath
      }
      writeProjectFile(target, projectFile)
      session().addRecentProject(target)
      return { path: target }
    }
  )

  ipcMain.handle(IpcChannel.projectFileRecent, async (): Promise<ProjectFileResult | null> => {
    const last = session().lastProject()
    if (!last || !existsSync(last)) return null
    try {
      return adoptProjectFile(last)
    } catch {
      return null
    }
  })

  ipcMain.on(IpcChannel.buildCancel, () => build?.cancel())

  ipcMain.on(IpcChannel.buildClean, (_event, projectDir: string) => {
    if (!isOpenProject(projectDir)) return
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
}

/** True only for the exact directory the current project was opened from. */
function isOpenProject(dir: unknown): dir is string {
  return typeof dir === 'string' && project !== null && resolve(dir) === project.rootDir
}

function openProject(rawDir: string): OpenProjectResult {
  const dir = resolve(rawDir)
  project = new ProjectFiles(dir)
  projectWatcher?.close()
  try {
    projectWatcher = watch(dir, { recursive: true }, (_type, filename) => {
      if (filename) {
        mainWindow?.webContents.send(IpcChannel.projectFileChanged, {
          path: join(dir, String(filename))
        })
      }
    })
  } catch {
    // Recursive watch is unsupported on Linux; the tree just will not
    // live-update there. Not fatal.
    projectWatcher = null
  }
  const envs = readEnvNames(dir)
  return { dir, name: basename(dir), envs }
}

/**
 * Read a `.pinbench` file, record it as recent, and re-adopt the PlatformIO
 * project it names so the Source tab and Build & flash come back with it.
 */
function adoptProjectFile(rawPath: string): ProjectFileResult {
  const path = resolve(rawPath)
  const projectFile = readProjectFile(path)
  session().addRecentProject(path)

  let pio: OpenProjectResult | null = null
  const dir = projectFile.platformioDir
  if (dir && existsSync(join(dir, 'platformio.ini'))) {
    pio = openProject(dir)
  }
  return { path, project: projectFile, pio }
}

function readEnvNames(dir: string): string[] {
  try {
    // Cheap and synchronous: enough to populate the env picker before a build.
    // The build itself re-reads via `pio project config` for the real merge.
    return parseEnvNamesFromIni(readFileSync(join(dir, 'platformio.ini'), 'utf8'))
  } catch {
    return []
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    app.setName('PinBench')
    registerIpc()
    Menu.setApplicationMenu(buildApplicationMenu(() => mainWindow))
    mainWindow = createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  app.on('before-quit', () => {
    emulator?.dispose()
    build?.dispose()
    void devices?.dispose()
    projectWatcher?.close()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
