import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseBoard } from '../../shared/board'
import { OPERATIONS, operation } from '../../shared/acp/operations'
import { createInvoker, type PinBenchAcpDeps } from './invoker'

const board = parseBoard(
  JSON.parse(
    readFileSync(resolve(__dirname, '../../../boards/thinknode-m9-v1.0.board.json'), 'utf8')
  )
)

function fakeDeps(): PinBenchAcpDeps {
  return {
    appInfo: vi.fn(() => ({ version: '0.1.0', platform: 'darwin' as const, isDev: true })),
    board: {
      current: vi.fn(() => board),
      edit: vi.fn(() => board),
      undo: vi.fn(() => board),
      redo: vi.fn(() => board)
    },
    project: {
      open: vi.fn(async (dir: string) => ({ dir, name: 'proj', envs: ['m9'] })),
      readTree: vi.fn(async () => [{ name: 'src', path: '/p/src', kind: 'dir' as const }]),
      readFile: vi.fn(async () => 'file body')
    },
    build: {
      start: vi.fn(),
      cancel: vi.fn(),
      clean: vi.fn(),
      status: vi.fn(() => ({ state: 'idle' as const }))
    },
    emulator: {
      start: vi.fn(),
      lastFirmware: vi.fn(() => null),
      stop: vi.fn(),
      reset: vi.fn(),
      status: vi.fn(() => ({ state: 'idle' as const }))
    },
    serial: {
      write: vi.fn(),
      recent: vi.fn(() => [{ t: 1, text: 'boot' }])
    },
    devices: { snapshots: vi.fn(() => [{ id: 'u2' }]), command: vi.fn() },
    menuCommand: vi.fn()
  }
}

const run = (deps: PinBenchAcpDeps, name: string, params: Record<string, unknown> = {}) =>
  createInvoker(deps)(operation(name)!, params)

describe('createInvoker — coverage', () => {
  it('has a branch for every operation (no "unhandled operation")', async () => {
    const deps = fakeDeps()
    const invoke = createInvoker(deps)
    for (const op of OPERATIONS) {
      const params: Record<string, unknown> = {}
      for (const field of op.params) {
        if (!field.required) continue
        params[field.name] =
          field.name === 'command'
            ? 'build.verifyPinMap'
            : field.type === 'object'
              ? {}
              : field.type === 'number'
                ? 1
                : 'x'
      }
      try {
        await invoke(op, params)
      } catch (error) {
        // A deliberate "not available" is fine; an unhandled switch case is not.
        expect((error as Error).message).not.toMatch(/unhandled operation/)
      }
    }
  })
})

describe('createInvoker — behaviour', () => {
  it('board_verify runs the rule engine against the live board', async () => {
    const deps = fakeDeps()
    const findings = await run(deps, 'board_verify')
    expect(Array.isArray(findings)).toBe(true)
    expect(deps.board.current).toHaveBeenCalled()
  })

  it('pinmap_preview returns a header and build flags', async () => {
    const out = (await run(fakeDeps(), 'pinmap_preview')) as {
      header: string
      buildFlags: string[]
    }
    expect(out.header).toContain('DO NOT EDIT')
    expect(out.buildFlags.every((f) => f.startsWith('-D'))).toBe(true)
  })

  it('build_start forwards the env; pinmap_write is still deferred', async () => {
    const deps = fakeDeps()
    await run(deps, 'build_start', { env: 'm9' })
    expect(deps.build.start).toHaveBeenCalledWith('m9')
    await expect(run(fakeDeps(), 'pinmap_write')).rejects.toThrow(/not available in this build/)
  })

  it('build_cancel / build_clean reach the runner and project', async () => {
    const deps = fakeDeps()
    await run(deps, 'build_cancel')
    await run(deps, 'build_clean')
    expect(deps.build.cancel).toHaveBeenCalled()
    expect(deps.build.clean).toHaveBeenCalled()
  })

  it('emulator_start boots a given image, falls back to the last one, else refuses', async () => {
    const deps = fakeDeps()
    await run(deps, 'emulator_start', { firmwarePath: '/fw.bin' })
    expect(deps.emulator.start).toHaveBeenLastCalledWith('/fw.bin')

    // pathless with a prior image → reuse it
    ;(deps.emulator.lastFirmware as ReturnType<typeof vi.fn>).mockReturnValue('/last.bin')
    await run(deps, 'emulator_start', {})
    expect(deps.emulator.start).toHaveBeenLastCalledWith('/last.bin')

    // pathless with nothing ever built → a clear error
    ;(deps.emulator.lastFirmware as ReturnType<typeof vi.fn>).mockReturnValue(null)
    await expect(run(deps, 'emulator_start', {})).rejects.toThrow(/no firmwarePath/)
  })

  it('board_edit / board_undo / board_redo mutate the main-held history', async () => {
    const deps = fakeDeps()
    const edit = { kind: 'moveParty', partId: 'u2', x: 1, y: 2 }
    await run(deps, 'board_edit', { edit })
    expect(deps.board.edit).toHaveBeenCalledWith(edit)
    await run(deps, 'board_undo')
    expect(deps.board.undo).toHaveBeenCalled()
    await run(deps, 'board_redo')
    expect(deps.board.redo).toHaveBeenCalled()
  })

  it('serial_read clamps the limit to a positive integer', async () => {
    const deps = fakeDeps()
    await run(deps, 'serial_read', { limit: 12.9 })
    expect(deps.serial.recent).toHaveBeenCalledWith(12)
    await run(deps, 'serial_read', {})
    expect(deps.serial.recent).toHaveBeenLastCalledWith(200)
  })

  it('device_command splits partId / command / args', async () => {
    const deps = fakeDeps()
    await run(deps, 'device_command', { partId: 'u2', command: 'inject', args: { rssi: -80 } })
    expect(deps.devices.command).toHaveBeenCalledWith('u2', 'inject', { rssi: -80 })
  })

  it('menu_command rejects an id not in the command table', async () => {
    const deps = fakeDeps()
    await expect(run(deps, 'menu_command', { command: 'file.launchMissiles' })).rejects.toThrow(
      /unknown menu command/
    )
    expect(deps.menuCommand).not.toHaveBeenCalled()
  })

  it('menu_command fires a known id', async () => {
    const deps = fakeDeps()
    await run(deps, 'menu_command', { command: 'build.verifyPinMap' })
    expect(deps.menuCommand).toHaveBeenCalledWith('build.verifyPinMap')
  })

  it('menu_command cannot be a bypass for a deferred operation', async () => {
    const deps = fakeDeps()
    await expect(run(deps, 'menu_command', { command: 'build.buildAndFlash' })).rejects.toThrow(
      /not available in this build/
    )
    expect(deps.menuCommand).not.toHaveBeenCalled()
  })

  it('project_open adopts the given directory', async () => {
    const deps = fakeDeps()
    const out = await run(deps, 'project_open', { dir: '/home/u/p' })
    expect(deps.project.open).toHaveBeenCalledWith('/home/u/p')
    expect(out).toMatchObject({ dir: '/home/u/p' })
  })
})
