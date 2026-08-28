import type { CommandId } from './commands'
import type { EmulatorStatus } from './emulator'
import type { SerialLine } from './serial'
import type { WorkspaceState } from './workspace'

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
  serialWrite: 'serial:write'
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
    start(firmwarePath: string): void
    stop(): void
    reset(): void
    onStatus(listener: (status: EmulatorStatus) => void): () => void
  }
  serial: {
    write(text: string): void
    onData(listener: (lines: SerialLine[]) => void): () => void
  }
}
