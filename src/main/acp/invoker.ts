/**
 * The binding half of the agent control plane (roadmap M16.2): one
 * {@link McpToolInvoker} that maps every {@link OPERATIONS} entry onto the
 * subsystems that already power the UI — the emulator supervisor, the build
 * runner, the device host, the board loader, the project file reader.
 *
 * Subsystems arrive as an injected {@link PinBenchAcpDeps} so this switch is
 * unit-testable with fakes and imports no Electron. The single place QEMU and
 * `pio` enter the bridge is whoever constructs the real deps (`src/main/acp/
 * bridge.ts`), not here.
 *
 * `mcp.ts` has already validated params against the operation's field specs
 * and cleared the permission gate before `invoke` runs, so each branch may
 * read `params.<field>` at the declared type.
 */

import { COMMANDS, type CommandId } from '../../shared/commands'
import type { AppInfo } from '../../shared/ipc'
import { boardTotals, type BoardDefinition } from '../../shared/board'
import type { BoardEdit } from '../../shared/boardEdit'
import type { BuildStatus } from '../../shared/build'
import type { EmulatorStatus } from '../../shared/emulator'
import type { FileNode } from '../../shared/files'
import type { SerialLine } from '../../shared/serial'
import type { McpToolInvoker } from '../../shared/acp/mcp'
import { generateBuildFlags, generatePinHeader } from '../../shared/codegen'
import { verifyBoard } from '../../shared/verify'

/** What the invoker needs from the running app. Every method may be async. */
export interface PinBenchAcpDeps {
  appInfo(): AppInfo | Promise<AppInfo>
  /**
   * The board document. The main process is the single authority (ADR 0002):
   * `edit` / `undo` / `redo` mutate its in-memory history and return the new
   * definition. `applyEdit` throws `BoardEditError` on a bad reference.
   */
  board: {
    current(): BoardDefinition | Promise<BoardDefinition>
    edit(edit: BoardEdit): BoardDefinition | Promise<BoardDefinition>
    undo(): BoardDefinition | Promise<BoardDefinition>
    redo(): BoardDefinition | Promise<BoardDefinition>
  }
  project: {
    /** Adopt the PlatformIO project at `dir`; throws if it holds no platformio.ini. */
    open(dir: string): Promise<{ dir: string; name: string; envs: string[] }>
    readTree(dir?: string): Promise<FileNode[]>
    readFile(path: string): Promise<string>
  }
  build: {
    /** Build `env` for the open project and boot the result. Throws if no project is open. */
    start(env: string): void
    cancel(): void
    clean(): void
    status(): BuildStatus | Promise<BuildStatus>
  }
  emulator: {
    start(firmwarePath: string): void
    /** The image last booted, for a pathless `emulator_start`. */
    lastFirmware(): string | null
    stop(): void
    reset(): void
    status(): EmulatorStatus | Promise<EmulatorStatus>
  }
  serial: {
    write(text: string): void
    /** Up to `limit` most recent UART0 lines, oldest first. */
    recent(limit: number): SerialLine[] | Promise<SerialLine[]>
  }
  devices: {
    snapshots(): unknown[] | Promise<unknown[]>
    command(partId: string, command: string, args?: Record<string, unknown>): void
  }
  /** Fire an application menu command by id. */
  menuCommand(command: CommandId): void
}

const COMMAND_IDS = new Set<string>(COMMANDS)
/**
 * Menu commands `menu_command` refuses because a typed operation covers the
 * same ground and should be used instead — `build.buildAndFlash` → `build_start`.
 * Keeping the denylist also means the two paths can't diverge in behaviour.
 */
const MENU_COMMAND_DENYLIST = new Set<string>(['build.buildAndFlash', 'build.flashUsb'])
const SERIAL_DEFAULT_LIMIT = 200

class NotAvailable extends Error {
  constructor(op: string, why: string) {
    super(`${op} is not available in this build — ${why}`)
    this.name = 'NotAvailable'
  }
}

export function createInvoker(deps: PinBenchAcpDeps): McpToolInvoker {
  return async (op, params) => {
    switch (op.name) {
      // ── Observe ────────────────────────────────────────────────────────────
      case 'app_info':
        return deps.appInfo()

      case 'board_get':
        return deps.board.current()

      case 'board_verify':
        return verifyBoard(await deps.board.current())

      case 'pinmap_preview': {
        const board = await deps.board.current()
        return { header: generatePinHeader(board), buildFlags: generateBuildFlags(board) }
      }

      case 'project_tree':
        return deps.project.readTree(params['path'] as string | undefined)

      case 'project_read_file':
        return {
          path: params['path'] as string,
          text: await deps.project.readFile(params['path'] as string)
        }

      case 'build_status':
        return deps.build.status()

      case 'emulator_status':
        return deps.emulator.status()

      case 'serial_read': {
        const limit = (params['limit'] as number | undefined) ?? SERIAL_DEFAULT_LIMIT
        return { lines: await deps.serial.recent(Math.max(1, Math.floor(limit))) }
      }

      case 'device_snapshots':
        return { devices: await deps.devices.snapshots() }

      // ── Edit the board document (main-authoritative history, ADR 0002) ─────
      case 'board_edit': {
        const board = await deps.board.edit(params['edit'] as BoardEdit)
        return { board, totals: boardTotals(board) }
      }

      case 'board_undo': {
        const board = await deps.board.undo()
        return { board, totals: boardTotals(board) }
      }

      case 'board_redo': {
        const board = await deps.board.redo()
        return { board, totals: boardTotals(board) }
      }

      case 'pinmap_write':
        throw new NotAvailable(
          op.name,
          'writing the header into the project lands with the M11.3 canvas; use pinmap_preview for the output'
        )

      // ── Act ───────────────────────────────────────────────────────────────
      case 'project_open': {
        const result = await deps.project.open(params['dir'] as string)
        return result
      }

      case 'build_start':
        deps.build.start(params['env'] as string)
        return { started: true, env: params['env'] }

      case 'build_cancel':
        deps.build.cancel()
        return { canceled: true }

      case 'build_clean':
        deps.build.clean()
        return { cleaned: true }

      case 'emulator_start': {
        const firmwarePath =
          (params['firmwarePath'] as string | undefined) ?? deps.emulator.lastFirmware()
        if (!firmwarePath) {
          throw new NotAvailable(
            op.name,
            'no firmwarePath given and nothing has been built or booted yet'
          )
        }
        deps.emulator.start(firmwarePath)
        return { started: true, firmwarePath }
      }

      case 'emulator_stop':
        deps.emulator.stop()
        return { stopped: true }

      case 'emulator_reset':
        deps.emulator.reset()
        return { reset: true }

      case 'serial_write':
        deps.serial.write(params['text'] as string)
        return { wrote: (params['text'] as string).length }

      case 'device_command':
        deps.devices.command(
          params['partId'] as string,
          params['command'] as string,
          params['args'] as Record<string, unknown> | undefined
        )
        return { sent: true }

      case 'menu_command': {
        const command = params['command'] as string
        if (!COMMAND_IDS.has(command)) {
          throw new Error(`unknown menu command: ${command}`)
        }
        if (MENU_COMMAND_DENYLIST.has(command)) {
          throw new NotAvailable(
            'menu_command',
            `"${command}" is gated — its dedicated operation lands in M16.3`
          )
        }
        deps.menuCommand(command as CommandId)
        return { invoked: command }
      }

      default:
        // Every OPERATIONS entry must have a branch above — the exhaustiveness
        // test in invoker.test.ts fails if this is ever reached.
        throw new Error(`unhandled operation: ${op.name}`)
    }
  }
}
