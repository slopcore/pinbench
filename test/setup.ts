import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { DEFAULT_WORKSPACE } from '../src/shared/workspace'
import type { BuildStatus } from '../src/shared/build'
import type { EmulatorStatus } from '../src/shared/emulator'
import type { AgentBridgeState, AgentPermissionRequest, PinBenchApi } from '../src/shared/ipc'
import type { WorkspaceState } from '../src/shared/workspace'

export interface TestBridge extends PinBenchApi {
  saved: WorkspaceState[]
  savedWorkspace: WorkspaceState
  /** Push a build-status change to whatever `useBuild` subscribed. */
  emitBuildState: (status: BuildStatus) => void
  /** Push an emulator-status change to whatever `useEmulator` subscribed. */
  emitEmulatorStatus: (status: EmulatorStatus) => void
  /** Push an agent-bridge-state change to whatever `useAgent` subscribed. */
  emitAgentState: (state: AgentBridgeState) => void
  /** Push a pending approval to whatever `useAgent` subscribed. */
  emitAgentPermission: (request: AgentPermissionRequest) => void
}

export function installBridge(initial: WorkspaceState = DEFAULT_WORKSPACE): TestBridge {
  const saved: WorkspaceState[] = []
  let buildStateListener: ((status: BuildStatus) => void) | null = null
  let emulatorStatusListener: ((status: EmulatorStatus) => void) | null = null
  let agentStateListener: ((state: AgentBridgeState) => void) | null = null
  let agentPermissionListener: ((request: AgentPermissionRequest) => void) | null = null
  const bridge: TestBridge = {
    saved,
    savedWorkspace: initial,
    emitBuildState: (status) => buildStateListener?.(status),
    emitEmulatorStatus: (status) => emulatorStatusListener?.(status),
    emitAgentState: (state) => agentStateListener?.(state),
    emitAgentPermission: (request) => agentPermissionListener?.(request),
    appInfo: () => Promise.resolve({ version: '0.1.0', platform: 'darwin', isDev: true }),
    launchState: vi.fn(() =>
      Promise.resolve({
        lastBoardId: null,
        folder: null,
        recentFolders: [],
        env: null,
        partConfig: {},
        boardEdits: []
      })
    ),
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
      saveProfile: vi.fn(() => Promise.resolve({ id: 'test-profile' })),
      remember: vi.fn(),
      exportPinHeader: vi.fn(() => Promise.resolve(null as string | null)),
      importPinHeader: vi.fn(() => Promise.resolve(null as string | null))
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
      onStatus: (cb) => {
        emulatorStatusListener = cb
        return () => {
          emulatorStatusListener = null
        }
      }
    },
    serial: {
      write: vi.fn(),
      onData: () => () => undefined
    },
    project: {
      open: vi.fn(() => Promise.resolve(null)),
      openAt: vi.fn(() => Promise.resolve({ error: 'no project in tests' as string })),
      openInEditor: vi.fn(() => Promise.resolve()),
      actions: vi.fn(() => Promise.resolve([])),
      onActions: () => () => undefined,
      setFolderState: vi.fn()
    },
    build: {
      start: vi.fn(),
      cancel: vi.fn(),
      clean: vi.fn(),
      onState: (cb) => {
        buildStateListener = cb
        return () => {
          buildStateListener = null
        }
      },
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
    agent: {
      state: vi.fn(() =>
        Promise.resolve({
          enabled: false,
          agentConfigured: false,
          ready: false,
          busy: false,
          autoApprove: false
        })
      ),
      onState: (cb) => {
        agentStateListener = cb
        return () => {
          agentStateListener = null
        }
      },
      backlog: vi.fn(() => Promise.resolve([] as unknown[])),
      onUpdate: () => () => undefined,
      prompt: vi.fn(() => Promise.resolve({ stopReason: 'end_turn' as string })),
      cancel: vi.fn(),
      setAutoApprove: vi.fn(),
      setPanelPresent: vi.fn(),
      onPermissionRequest: (cb) => {
        agentPermissionListener = cb
        return () => {
          agentPermissionListener = null
        }
      },
      resolvePermission: vi.fn()
    },
    devices: {
      onSnapshot: () => () => undefined,
      onEvent: () => () => undefined,
      onDiagnostic: () => () => undefined,
      onFramebuffer: () => () => undefined,
      onMeshIdentity: () => () => undefined,
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
