import { join } from 'node:path'
import { BrowserWindow, Menu, app, dialog, ipcMain, shell } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { AppInfo, WindowState } from '../shared/ipc'
import { normaliseWorkspace } from '../shared/workspace'
import { buildApplicationMenu } from './menu'
import { EmulatorSupervisor } from './emulator'
import { SessionStore } from './store'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let store: SessionStore | null = null
let emulator: EmulatorSupervisor | null = null

const session = (): SessionStore => {
  store ??= new SessionStore()
  return store
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

  ipcMain.on(IpcChannel.emulatorStart, (_event, firmwarePath: string) => {
    emu().start(firmwarePath)
  })

  ipcMain.on(IpcChannel.emulatorStop, () => {
    emu().stop()
  })

  ipcMain.on(IpcChannel.emulatorReset, () => {
    emu().reset()
  })

  ipcMain.on(IpcChannel.serialWrite, (_event, text: string) => {
    emu().writeSerial(text)
  })
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
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
