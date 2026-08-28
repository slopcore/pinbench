/**
 * The whole renderer-to-main surface, in one file.
 *
 * The renderer is sandboxed with context isolation on and has no Node access;
 * everything privileged goes through these channels and the preload bridge that
 * wraps them. Adding a capability means adding it here first — that is the
 * point of establishing this in M1 rather than retrofitting it once the
 * emulator supervisor exists.
 */

import type { CommandId } from './commands'
import type { WorkspaceState } from './workspace'

export const IpcChannel = {
  workspaceLoad: 'workspace:load',
  workspaceSave: 'workspace:save',
  appInfo: 'app:info',
  windowMinimise: 'window:minimise',
  windowToggleMaximise: 'window:toggle-maximise',
  windowClose: 'window:close',
  windowState: 'window:state',
  menuCommand: 'menu:command'
} as const

export interface AppInfo {
  version: string
  platform: NodeJS.Platform
  /** True in `electron-vite dev`; the renderer uses it for dev-only affordances. */
  isDev: boolean
}

export interface WindowState {
  maximised: boolean
  fullScreen: boolean
  focused: boolean
}

/** The API the preload script exposes as `window.pinbench`. */
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
    /** Returns an unsubscribe function. */
    onStateChange(listener: (state: WindowState) => void): () => void
  }
  /** Native-menu commands arrive here. Returns an unsubscribe function. */
  onMenuCommand(listener: (command: CommandId) => void): () => void
}
