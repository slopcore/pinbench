/**
 * Assembles the agent control plane in the main process (roadmap M16.2):
 * builds a {@link PinBenchAcpDeps} from the live supervisors, composes the
 * permission gate, and stands up the loopback MCP server ({@link
 * startAcpControlServer}).
 *
 * Only reached when PinBench is started `--acp` / `PINBENCH_ACP=1` — see
 * {@link acpRequested}. The agent-side ACP connection (spawning the agent,
 * the prompt turn, `session/update` streaming) is M16.3; this milestone puts
 * the operations on a wire an agent can call.
 */

import type { BoardDefinition } from '../../shared/board'
import type { CommandId } from '../../shared/commands'
import type { FileNode } from '../../shared/files'
import type { SerialLine } from '../../shared/serial'
import type { DeviceSnapshotMessage } from '../../shared/devices/messages'
import { defaultPermissionPolicy } from '../../shared/acp/operations'
import type { OperationDescriptor } from '../../shared/acp/operations'
import { createInvoker, type PinBenchAcpDeps } from './invoker'
import { startAcpControlServer, type AcpControlServerHandle } from './httpServer'

/** True when this launch asked for the agent bridge. */
export function acpRequested(argv: readonly string[] = process.argv, env = process.env): boolean {
  return argv.includes('--acp') || env['PINBENCH_ACP'] === '1'
}

interface EmulatorLike {
  getStatus(): { state: string }
  start(firmwarePath: string): void
  reset(): void
  stop(): void
  writeSerial(text: string): void
  on(event: 'serial', listener: (lines: SerialLine[]) => void): unknown
}

interface BuildLike {
  getStatus(): unknown
  cancel(): void
}

interface DeviceHostLike {
  command(partId: string, command: string, args?: Record<string, unknown>): void
  on(event: 'snapshot', listener: (message: DeviceSnapshotMessage) => void): unknown
}

export interface AcpBridgeWiring {
  appVersion: string
  platform: NodeJS.Platform
  isDev: boolean
  emulator: EmulatorLike
  build: BuildLike
  devices: DeviceHostLike
  /** The board the main process currently holds authority over (ADR 0002). */
  getBoard(): BoardDefinition | null
  project: {
    open(dir: string): Promise<{ dir: string; name: string; envs: string[] }>
    readTree(dir?: string): Promise<FileNode[]>
    readFile(path: string): Promise<string>
    /** Delete the build caches for the open project. Throws if no project is open. */
    clean(): void
  }
  menuCommand(command: CommandId): void
  /**
   * The interactive permission prompt for an `exec` operation. Resolves `true`
   * to allow. Only called for operations {@link defaultPermissionPolicy} marks
   * `ask`.
   */
  confirm(op: OperationDescriptor): Promise<boolean>
  /** How many trailing serial lines to keep for `serial_read`. */
  serialBufferLines?: number
}

const DEFAULT_SERIAL_BUFFER = 2000

export interface AcpBridge {
  readonly server: AcpControlServerHandle
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

  const deps: PinBenchAcpDeps = {
    appInfo: () => ({
      version: wiring.appVersion,
      platform: wiring.platform,
      isDev: wiring.isDev
    }),
    boardDefinition: () => {
      const board = wiring.getBoard()
      if (!board) throw new Error('no board is loaded')
      return board
    },
    project: {
      open: (dir) => wiring.project.open(dir),
      readTree: (dir) => wiring.project.readTree(dir),
      readFile: (path) => wiring.project.readFile(path)
    },
    build: {
      cancel: () => wiring.build.cancel(),
      clean: () => wiring.project.clean(),
      status: () => wiring.build.getStatus() as never
    },
    emulator: {
      start: (firmwarePath) => {
        if (firmwarePath) wiring.emulator.start(firmwarePath)
        else wiring.emulator.reset()
      },
      stop: () => wiring.emulator.stop(),
      reset: () => wiring.emulator.reset(),
      status: () => wiring.emulator.getStatus() as never
    },
    serial: {
      write: (text) => wiring.emulator.writeSerial(text),
      recent: (limit) => serialRing.slice(-limit)
    },
    devices: {
      snapshots: () => [...snapshots.values()],
      command: (partId, command, args) => wiring.devices.command(partId, command, args)
    },
    menuCommand: (command) => wiring.menuCommand(command)
  }

  const authorize = async (op: OperationDescriptor): Promise<boolean> =>
    defaultPermissionPolicy(op) === 'allow' ? true : wiring.confirm(op)

  const server = await startAcpControlServer({
    serverName: 'pinbench',
    serverVersion: wiring.appVersion,
    invoke: createInvoker(deps),
    authorize
  })

  return {
    server,
    dispose: async () => {
      ;(wiring.emulator as unknown as { off?: typeof wiring.emulator.on }).off?.('serial', onSerial)
      ;(wiring.devices as unknown as { off?: typeof wiring.devices.on }).off?.(
        'snapshot',
        onSnapshot
      )
      await server.close()
    }
  }
}
