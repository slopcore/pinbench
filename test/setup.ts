import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { DEFAULT_WORKSPACE } from '../src/shared/workspace'
import type { PinBenchApi } from '../src/shared/ipc'
import type { WorkspaceState } from '../src/shared/workspace'

export interface TestBridge extends PinBenchApi {
  saved: WorkspaceState[]
  savedWorkspace: WorkspaceState
}

export function installBridge(initial: WorkspaceState = DEFAULT_WORKSPACE): TestBridge {
  const saved: WorkspaceState[] = []
  const bridge: TestBridge = {
    saved,
    savedWorkspace: initial,
    appInfo: () => Promise.resolve({ version: '0.1.0', platform: 'darwin', isDev: true }),
    workspace: {
      load: () => Promise.resolve(bridge.savedWorkspace),
      save: (state) => {
        saved.push(state)
        bridge.savedWorkspace = state
      }
    },
    board: {
      load: vi.fn(() => Promise.resolve({ error: 'no board in tests' as string })),
      list: vi.fn(() => Promise.resolve([] as string[])),
      exportPinHeader: vi.fn(() => Promise.resolve(null as string | null)),
      importPinHeader: vi.fn(() => Promise.resolve(null as string | null))
    },
    projectFile: {
      open: vi.fn(() => Promise.resolve(null)),
      save: vi.fn(() => Promise.resolve({ canceled: true as const })),
      recent: vi.fn(() => Promise.resolve(null))
    },
    window: {
      minimise: vi.fn(),
      toggleMaximise: vi.fn(),
      close: vi.fn(),
      onStateChange: () => () => undefined
    },
    onMenuCommand: () => () => undefined,
    emulator: {
      openFirmware: vi.fn(() => Promise.resolve(null)),
      start: vi.fn(),
      stop: vi.fn(),
      reset: vi.fn(),
      onStatus: () => () => undefined
    },
    serial: {
      write: vi.fn(),
      onData: () => () => undefined
    },
    project: {
      open: vi.fn(() => Promise.resolve(null)),
      readTree: vi.fn(() => Promise.resolve([])),
      readFile: vi.fn(() => Promise.resolve('')),
      onFileChanged: () => () => undefined
    },
    build: {
      start: vi.fn(),
      cancel: vi.fn(),
      clean: vi.fn(),
      onState: () => () => undefined,
      onOutput: () => () => undefined,
      onDiagnostics: () => () => undefined
    },
    usbFlash: {
      listPorts: vi.fn(() => Promise.resolve([])),
      start: vi.fn(),
      cancel: vi.fn(),
      onState: () => () => undefined,
      onOutput: () => () => undefined
    },
    devices: {
      onSnapshot: () => () => undefined,
      onEvent: () => () => undefined,
      onDiagnostic: () => () => undefined,
      onFramebuffer: () => () => undefined,
      command: vi.fn()
    }
  }
  Object.defineProperty(window, 'pinbench', { value: bridge, configurable: true, writable: true })
  return bridge
}

if (!('ResizeObserver' in globalThis)) {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    writable: true,
    value: class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  })
}

if (typeof Element !== 'undefined' && !Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = function setPointerCapture(): void {}
  Element.prototype.releasePointerCapture = function releasePointerCapture(): void {}
  Element.prototype.hasPointerCapture = function hasPointerCapture(): boolean {
    return true
  }
}

afterEach(() => {
  vi.useRealTimers()
})
