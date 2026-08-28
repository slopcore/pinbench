import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { DEFAULT_WORKSPACE } from '../src/shared/workspace'
import type { PinBenchApi } from '../src/shared/ipc'
import type { WorkspaceState } from '../src/shared/workspace'

/**
 * A fake preload bridge. The renderer is written as though `window.pinbench` is
 * the only way out of the sandbox, so faking it here is enough to drive the
 * whole shell in tests.
 */
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
    window: {
      minimise: vi.fn(),
      toggleMaximise: vi.fn(),
      close: vi.fn(),
      onStateChange: () => () => undefined
    },
    onMenuCommand: () => () => undefined
  }
  Object.defineProperty(window, 'pinbench', { value: bridge, configurable: true, writable: true })
  return bridge
}

// jsdom has neither of these, and the canvas leans on both.
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

if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = function setPointerCapture(): void {}
  Element.prototype.releasePointerCapture = function releasePointerCapture(): void {}
  Element.prototype.hasPointerCapture = function hasPointerCapture(): boolean {
    return true
  }
}

afterEach(() => {
  vi.useRealTimers()
})
