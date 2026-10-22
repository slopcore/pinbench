import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadBoard } from '../board'
import { createInvoker, type PinBenchAcpDeps } from './invoker'
import { operation } from '../../shared/acp/operations'
import { startAcpBridge, type AcpBridge, type AcpBridgeWiring } from './bridge'
import type { BoardEdit } from '../../shared/boardEdit'

const m1Board = loadBoard('thinknode-m1-v1.0')

function fakeDeps(board = m1Board): PinBenchAcpDeps {
  let currentBoard = board
  return {
    appInfo: vi.fn(() => ({ version: '0.1.0', platform: 'darwin' as const, isDev: true })),
    board: {
      current: vi.fn(() => currentBoard),
      edit: vi.fn((edit: BoardEdit) => {
        if (edit.kind === 'moveParty') {
          currentBoard = {
            ...currentBoard,
            parts: currentBoard.parts.map((p) =>
              p.id === edit.partId ? { ...p, layout: { ...p.layout, x: edit.x, y: edit.y } } : p
            )
          }
        }
        return currentBoard
      }),
      undo: vi.fn(() => currentBoard),
      redo: vi.fn(() => currentBoard)
    },
    project: {
      open: vi.fn(async (dir: string) => ({
        dir,
        name: 'MeshCore',
        envs: ['ThinkNode_M1_repeater']
      })),
      actions: vi.fn(async () => [])
    },
    build: {
      start: vi.fn(),
      cancel: vi.fn(),
      clean: vi.fn(),
      status: vi.fn(() => ({ state: 'idle' as const }))
    },
    emulator: {
      start: vi.fn(),
      lastFirmware: vi.fn(() => '/build/thinknode_m1.bin'),
      stop: vi.fn(),
      reset: vi.fn(),
      status: vi.fn(() => ({ state: 'idle' as const }))
    },
    serial: {
      write: vi.fn(),
      recent: vi.fn(() => [{ t: 1, text: 'booting ThinkNode M1...' }])
    },
    devices: {
      snapshots: vi.fn(() => [
        { partId: 'u2', mode: 'standby', freqHz: 915000000 },
        { partId: 'u3', panel: '200×200 mono e-ink' }
      ]),
      command: vi.fn()
    },
    menuCommand: vi.fn()
  }
}

const runOp = (deps: PinBenchAcpDeps, name: string, params: Record<string, unknown> = {}) =>
  createInvoker(deps)(operation(name)!, params)

describe('ThinkNode M1 — ACP Invoker operations', () => {
  it('board_get returns the ThinkNode M1 hardware profile', async () => {
    const deps = fakeDeps()
    const result = (await runOp(deps, 'board_get')) as typeof m1Board
    expect(result.id).toBe('thinknode-m1-v1.0')
    expect(result.name).toBe('ThinkNode M1 V1.0')
    expect(result.vendor).toBe('Elecrow')
    expect(result.mcu).toBe('nRF52840')
    expect(result.emulator.machine).toBe('esp32s3')
    expect(result.firmware).toEqual({
      env: 'ThinkNode_M1_companion_radio_ble',
      envMatch: 'thinknode_m1'
    })
    expect(result.parts.map((p) => p.id)).toEqual(['u1', 'u2', 'u3', 'u4', 'u5', 'u6'])
  })

  it('board_verify verifies ThinkNode M1 pin mapping cleanly', async () => {
    const deps = fakeDeps()
    const findings = (await runOp(deps, 'board_verify')) as Array<{
      severity: string
      message: string
    }>
    expect(Array.isArray(findings)).toBe(true)
    // There are no errors or chip-select conflicts on the shipped profile
    expect(findings.filter((f) => f.severity === 'error')).toHaveLength(0)
    expect(findings.some((f) => f.message.includes('chip-selects share'))).toBe(false)
  })

  it('pinmap_preview generates correct C headers and build flags for ThinkNode M1', async () => {
    const deps = fakeDeps()
    const out = (await runOp(deps, 'pinmap_preview')) as {
      header: string
      buildFlags: string[]
    }
    expect(out.header).toContain('/* Board: ThinkNode M1 V1.0 (thinknode-m1-v1.0) — nRF52840 */')
    expect(out.header).toContain('#define PINBENCH_THINKNODE_M1_V1_0_PINS_H')
    // SX1262 LoRa NSS (24), BUSY (17), DIO1 (20), RESET (25), TX_LED (13)
    expect(out.header).toMatch(/#define U2_NSS_PIN\s+24/)
    expect(out.header).toMatch(/#define U2_BUSY_PIN\s+17/)
    expect(out.header).toMatch(/#define U2_DIO1_PIN\s+20/)
    expect(out.header).toMatch(/#define U2_RESET_PIN\s+25/)
    expect(out.header).toMatch(/#define U2_TX_LED_PIN\s+13/)
    // Display CS (30), DC (28), RST (2), BUSY (3)
    expect(out.header).toMatch(/#define U3_CS_PIN\s+30/)
    expect(out.header).toMatch(/#define U3_DC_PIN\s+28/)
    expect(out.header).toMatch(/#define U3_RST_PIN\s+2/)
    expect(out.header).toMatch(/#define U3_BUSY_PIN\s+3/)
    // User button (42)
    expect(out.header).toMatch(/#define SW1_BTN_PIN\s+42/)
    // Build flags list
    expect(out.buildFlags).toContain('-D U2_NSS_PIN=24')
    expect(out.buildFlags).toContain('-D U3_CS_PIN=30')
    expect(out.buildFlags).toContain('-D SW1_BTN_PIN=42')
  })

  it('board_edit, undo, and redo mutate ThinkNode M1 through ACP', async () => {
    const deps = fakeDeps()
    const editResult = (await runOp(deps, 'board_edit', {
      edit: { kind: 'moveParty', partId: 'u2', x: 100, y: 150 }
    })) as { board: typeof m1Board; totals: { parts: number; nets: number } }

    expect(deps.board.edit).toHaveBeenCalledWith({
      kind: 'moveParty',
      partId: 'u2',
      x: 100,
      y: 150
    })
    expect(editResult.totals.parts).toBe(6)

    await runOp(deps, 'board_undo')
    expect(deps.board.undo).toHaveBeenCalled()

    await runOp(deps, 'board_redo')
    expect(deps.board.redo).toHaveBeenCalled()
  })

  it('device_command drives SX1262 LoRa packet injection on ThinkNode M1', async () => {
    const deps = fakeDeps()
    await runOp(deps, 'device_command', {
      partId: 'u2',
      command: 'inject',
      args: { kind: 'channel', text: 'Hello from ACP mesh!', rssi: -75 }
    })
    expect(deps.devices.command).toHaveBeenCalledWith('u2', 'inject', {
      kind: 'channel',
      text: 'Hello from ACP mesh!',
      rssi: -75
    })
  })

  it('build_start selects ThinkNode M1 firmware environment', async () => {
    const deps = fakeDeps()
    await runOp(deps, 'build_start', { env: 'ThinkNode_M1_repeater' })
    expect(deps.build.start).toHaveBeenCalledWith('ThinkNode_M1_repeater')
  })
})

describe('ThinkNode M1 — ACP Bridge and Control Server end-to-end', () => {
  let bridge: AcpBridge | null = null

  afterEach(async () => {
    await bridge?.dispose()
    bridge = null
  })

  async function callMcpTool(url: string, token: string, name: string, args: unknown = {}) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args }
      })
    })
    return (await res.json()) as {
      result: { isError?: boolean; structuredContent?: unknown; content: { text: string }[] }
    }
  }

  function createWiring(board = m1Board): AcpBridgeWiring {
    const emulator = Object.assign(new EventEmitter(), {
      getStatus: () => ({ state: 'idle' }),
      start: vi.fn(),
      lastFirmware: vi.fn(() => '/fw/thinknode_m1.bin'),
      reset: vi.fn(),
      stop: vi.fn(),
      writeSerial: vi.fn()
    })
    const devices = Object.assign(new EventEmitter(), { command: vi.fn(), load: vi.fn() })
    return {
      appVersion: '0.1.0',
      platform: 'darwin',
      isDev: true,
      emulator: emulator as never,
      build: { getStatus: () => ({ state: 'idle' }), start: vi.fn(), cancel: vi.fn() },
      devices: devices as never,
      getBoard: () => board,
      onBoardChanged: vi.fn(),
      project: {
        open: vi.fn(async (dir: string) => ({ dir, name: 'p', envs: ['ThinkNode_M1_repeater'] })),
        readFile: vi.fn(async () => ''),
        actions: vi.fn(async () => []),
        rootDir: () => '/home/u/MeshCore',
        clean: vi.fn()
      },
      menuCommand: vi.fn(),
      confirm: vi.fn(async () => true),
      agent: null
    }
  }

  it('serves ThinkNode M1 board_get and board_verify via ACP control server', async () => {
    const w = createWiring()
    bridge = await startAcpBridge(w)

    const getRes = await callMcpTool(bridge.server.url, bridge.server.token, 'board_get')
    expect(getRes.result.isError).toBeUndefined()
    const returnedBoard = getRes.result.structuredContent as typeof m1Board
    expect(returnedBoard.id).toBe('thinknode-m1-v1.0')
    expect(returnedBoard.name).toBe('ThinkNode M1 V1.0')
    expect(returnedBoard.vendor).toBe('Elecrow')
    expect(returnedBoard.mcu).toBe('nRF52840')

    const verifyRes = await callMcpTool(bridge.server.url, bridge.server.token, 'board_verify')
    expect(verifyRes.result.isError).toBeUndefined()
  })

  it('performs board_edit on ThinkNode M1 over ACP and notifies device host', async () => {
    const w = createWiring()
    bridge = await startAcpBridge(w)

    const edit = { kind: 'moveParty' as const, partId: 'u3', x: 500, y: 80 }
    const editRes = await callMcpTool(bridge.server.url, bridge.server.token, 'board_edit', {
      edit
    })
    expect(editRes.result.isError).toBeUndefined()
    expect(w.onBoardChanged).toHaveBeenCalledTimes(1)
    expect((w.devices as unknown as { load: ReturnType<typeof vi.fn> }).load).toHaveBeenCalledTimes(
      1
    )

    const boardRes = await callMcpTool(bridge.server.url, bridge.server.token, 'board_get')
    const updated = boardRes.result.structuredContent as {
      parts: { id: string; layout: { x: number; y: number } }[]
    }
    expect(updated.parts.find((p) => p.id === 'u3')!.layout).toMatchObject({ x: 500, y: 80 })
  })

  it('generates pinmap_preview for ThinkNode M1 through ACP', async () => {
    const w = createWiring()
    bridge = await startAcpBridge(w)

    const previewRes = await callMcpTool(bridge.server.url, bridge.server.token, 'pinmap_preview')
    expect(previewRes.result.isError).toBeUndefined()
    const content = previewRes.result.structuredContent as { header: string; buildFlags: string[] }
    expect(content.header).toContain('ThinkNode M1 V1.0')
    expect(content.buildFlags).toContain('-D U2_NSS_PIN=24')
    expect(content.buildFlags).toContain('-D U3_CS_PIN=30')
  })
})
