/**
 * Assembles the agent control plane in the main process (roadmap M16.2–M16.3):
 *
 *  - builds a {@link PinBenchAcpDeps} from the live supervisors and a
 *    main-authoritative board history (ADR 0002);
 *  - composes the permission gate (`read`/`write` auto, `exec` → the host's
 *    `confirm`);
 *  - stands up the loopback MCP control server ({@link startAcpControlServer});
 *  - when an agent command is configured, spawns it, opens an
 *    {@link AcpConnection}, and drives an {@link AgentSession} that lists the
 *    control server so the agent's model can call PinBench's operations.
 *
 * Only reached when PinBench is started `--acp` / `PINBENCH_ACP=1` — see
 * {@link acpRequested}.
 */

import type { BoardDefinition } from '../../shared/board'
import { BoardHistory, type BoardEdit } from '../../shared/boardEdit'
import type { CommandId } from '../../shared/commands'
import type { FirmwareAction } from '../../shared/actions'
import type { SerialLine } from '../../shared/serial'
import type { DeviceSnapshotMessage } from '../../shared/devices/messages'
import { defaultPermissionPolicy } from '../../shared/acp/operations'
import type { OperationDescriptor } from '../../shared/acp/operations'
import { createInvoker, type PinBenchAcpDeps } from './invoker'
import { startAcpControlServer, type AcpControlServerHandle } from './httpServer'
import { AcpConnection } from './connection'
import { AgentSession, type SessionCallbacks } from './agentSession'
import { agentCommandFromEnv, spawnAgent, type AgentCommand, type SpawnedAgent } from './agent'

/** True when this launch asked for the agent bridge. */
export function acpRequested(argv: readonly string[] = process.argv, env = process.env): boolean {
  return argv.includes('--acp') || env['PINBENCH_ACP'] === '1'
}

interface EmulatorLike {
  getStatus(): { state: string }
  start(firmwarePath: string): void
  lastFirmware(): string | null
  reset(): void
  stop(): void
  writeSerial(text: string): void
  on(event: 'serial', listener: (lines: SerialLine[]) => void): unknown
  off?(event: 'serial', listener: (lines: SerialLine[]) => void): unknown
}

interface BuildLike {
  getStatus(): unknown
  start(env: string): void
  cancel(): void
}

interface DeviceHostLike {
  load(board: BoardDefinition): void
  command(partId: string, command: string, args?: Record<string, unknown>): void
  snapshots?(): unknown[]
  on(event: 'snapshot', listener: (message: DeviceSnapshotMessage) => void): unknown
}

export interface AcpBridgeWiring {
  appVersion: string
  platform: NodeJS.Platform
  isDev: boolean
  emulator: EmulatorLike
  build: BuildLike
  devices: DeviceHostLike
  /** The board the app currently holds — seeds the bridge's authoritative history. */
  getBoard(): BoardDefinition | null
  /** Called after every board edit / undo / redo so the app re-syncs (device host, renderer). */
  onBoardChanged(board: BoardDefinition): void
  project: {
    open(dir: string): Promise<{ dir: string; name: string; envs: string[] }>
    /** Read a file in the open project (the agent's `fs/read_text_file`). Never writes. */
    readFile(path: string): Promise<string>
    /** Recompute the required firmware changes (`firmware_actions`). */
    actions(): Promise<FirmwareAction[]>
    /** Delete the build caches for the open project. Throws if no project is open. */
    clean(): void
    /** Absolute root of the open project, or null. Used as the agent session cwd. */
    rootDir(): string | null
  }
  menuCommand(command: CommandId): void
  /**
   * The interactive permission prompt for an `exec` operation. Resolves `true`
   * to allow. Only called for operations {@link defaultPermissionPolicy} marks
   * `ask`.
   */
  confirm(op: OperationDescriptor): Promise<boolean>
  /**
   * The host's "auto-approve agent actions" switch. When it returns `true`,
   * `exec` ops run without calling {@link confirm}. Absent ⇒ always prompt.
   */
  autoApprove?(): boolean
  /** ACP `session/request_permission` from the agent — the tool-call approval prompt. */
  requestAgentPermission?(params: unknown): Promise<{
    outcome: { outcome: string; optionId?: string }
  }>
  /** A streamed `session/update` from the agent (assistant text, tool calls, plans). */
  onAgentUpdate?(params: unknown): void
  /** The agent command; defaults to `PINBENCH_AGENT_CMD` / `PINBENCH_AGENT_ARGS`. */
  agent?: AgentCommand | null
  /** Fail the agent handshake after this long (ms). Default 15000. */
  agentStartTimeoutMs?: number
  /** How many trailing serial lines to keep for `serial_read`. */
  serialBufferLines?: number
}

const DEFAULT_SERIAL_BUFFER = 2000

export interface AcpBridge {
  readonly server: AcpControlServerHandle
  /** The agent session, once `session/new` has resolved. Null until then / when no agent. */
  readonly session: AgentSession | null
  /** Resolves once the agent handshake has finished (or failed — never rejects). */
  readonly ready: Promise<void>
  /** Send a prompt to the agent. Rejects if no agent is running. */
  prompt(text: string): Promise<{ stopReason: string }>
  dispose(): Promise<void>
}

export async function startAcpBridge(wiring: AcpBridgeWiring): Promise<AcpBridge> {
  const serialCap = wiring.serialBufferLines ?? DEFAULT_SERIAL_BUFFER
  const serialRing: SerialLine[] = []
  const onSerial = (lines: SerialLine[]): void => {
    serialRing.push(...lines)
    if (serialRing.length > serialCap) serialRing.splice(0, serialRing.length - serialCap)
  }
  wiring.emulator.on('serial', onSerial)

  const snapshots = new Map<string, unknown>()
  const onSnapshot = (message: DeviceSnapshotMessage): void => {
    snapshots.set(message.partId, message)
  }
  wiring.devices.on('snapshot', onSnapshot)

  // The main process is the single authority on the board document (ADR 0002).
  // Seeded lazily from whatever the app currently holds.
  let history: BoardHistory | null = null
  const ensureHistory = (): BoardHistory => {
    if (!history) {
      const board = wiring.getBoard()
      if (!board) throw new Error('no board is loaded')
      history = new BoardHistory(board)
    }
    return history
  }
  const commitBoard = (board: BoardDefinition): BoardDefinition => {
    wiring.devices.load(board)
    wiring.onBoardChanged(board)
    return board
  }

  const deps: PinBenchAcpDeps = {
    appInfo: () => ({
      version: wiring.appVersion,
      platform: wiring.platform,
      isDev: wiring.isDev
    }),
    board: {
      current: () => (history ? history.present : requireBoard(wiring.getBoard())),
      edit: (edit: BoardEdit) => commitBoard(ensureHistory().apply(edit)),
      undo: () => commitBoard(ensureHistory().undo()),
      redo: () => commitBoard(ensureHistory().redo())
    },
    project: {
      open: (dir) => wiring.project.open(dir),
      actions: () => wiring.project.actions()
    },
    build: {
      start: (env) => wiring.build.start(env),
      cancel: () => wiring.build.cancel(),
      clean: () => wiring.project.clean(),
      status: () => wiring.build.getStatus() as never
    },
    emulator: {
      start: (firmwarePath) => wiring.emulator.start(firmwarePath),
      lastFirmware: () => wiring.emulator.lastFirmware(),
      stop: () => wiring.emulator.stop(),
      reset: () => wiring.emulator.reset(),
      status: () => wiring.emulator.getStatus() as never
    },
    serial: {
      write: (text) => wiring.emulator.writeSerial(text),
      recent: (limit) => serialRing.slice(-limit)
    },
    devices: {
      snapshots: () =>
        wiring.devices.snapshots ? wiring.devices.snapshots() : [...snapshots.values()],
      command: (partId, command, args) => wiring.devices.command(partId, command, args)
    },
    menuCommand: (command) => wiring.menuCommand(command)
  }

  const authorize = async (op: OperationDescriptor): Promise<boolean> =>
    defaultPermissionPolicy(op) === 'allow' || wiring.autoApprove?.() === true
      ? true
      : wiring.confirm(op)

  const server = await startAcpControlServer({
    serverName: 'pinbench',
    serverVersion: wiring.appVersion,
    invoke: createInvoker(deps),
    authorize
  })

  // ── The agent, if one is configured ──────────────────────────────────────
  // `spawned` is tracked in the closure so `dispose` can always kill the child,
  // even if `session.start()` is still pending or has hung.
  let spawned: SpawnedAgent | null = null
  let session: AgentSession | null = null
  let sessionReady: Promise<void> = Promise.resolve()

  // `agent: null` means "no agent, don't look at the env"; omitting it falls
  // back to PINBENCH_AGENT_CMD.
  const agentCommand = wiring.agent === undefined ? agentCommandFromEnv() : wiring.agent
  if (agentCommand) {
    const cwd = wiring.project.rootDir() ?? process.cwd()
    spawned = spawnAgent(agentCommand, cwd)
    const connection = new AcpConnection(spawned.transport)
    const callbacks: SessionCallbacks = {
      fs: {
        readTextFile: (path) => wiring.project.readFile(path)
      },
      requestPermission: (params) =>
        wiring.requestAgentPermission
          ? wiring.requestAgentPermission(params)
          : Promise.resolve({ outcome: { outcome: 'cancelled' } }),
      onUpdate: (params) => wiring.onAgentUpdate?.(params)
    }
    const candidate = new AgentSession({
      connection,
      clientInfo: { name: 'PinBench', version: wiring.appVersion },
      cwd,
      mcpServerUrl: server.url,
      mcpServerToken: server.token,
      callbacks,
      ...(wiring.agentStartTimeoutMs === undefined
        ? {}
        : { startTimeoutMs: wiring.agentStartTimeoutMs })
    })
    // Do NOT await here: a missing / hung / misconfigured agent must not stop
    // `startAcpBridge` resolving, or `dispose` never gets a handle to kill it.
    sessionReady = candidate
      .start()
      .then(() => {
        session = candidate
      })
      .catch((error: unknown) => {
        process.stderr.write(`[pinbench] agent session failed to start: ${String(error)}\n`)
        spawned?.kill()
        spawned = null
      })
  }

  return {
    server,
    get session() {
      return session
    },
    ready: sessionReady,
    prompt: async (text) => {
      await sessionReady
      if (!session) throw new Error('no agent is running')
      return session.prompt(text)
    },
    dispose: async () => {
      session?.cancel()
      spawned?.kill()
      ;(wiring.emulator as unknown as { off?: typeof wiring.emulator.on }).off?.('serial', onSerial)
      ;(wiring.devices as unknown as { off?: typeof wiring.devices.on }).off?.(
        'snapshot',
        onSnapshot
      )
      await server.close()
    }
  }
}

function requireBoard(board: BoardDefinition | null): BoardDefinition {
  if (!board) throw new Error('no board is loaded')
  return board
}
