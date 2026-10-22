import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseBoard } from '../../shared/board'
import { acpRequested, startAcpBridge, type AcpBridge, type AcpBridgeWiring } from './bridge'

describe('acpRequested', () => {
  it('is true only for --acp or PINBENCH_ACP=1', () => {
    expect(acpRequested(['node', 'main'], {})).toBe(false)
    expect(acpRequested(['node', 'main', '--acp'], {})).toBe(true)
    expect(acpRequested(['node', 'main'], { PINBENCH_ACP: '1' })).toBe(true)
    expect(acpRequested(['node', 'main'], { PINBENCH_ACP: '0' })).toBe(false)
  })
})

const board = parseBoard(
  JSON.parse(
    readFileSync(resolve(__dirname, '../../../boards/thinknode-m9-v1.0.board.json'), 'utf8')
  )
)

let bridge: AcpBridge | null = null
afterEach(async () => {
  await bridge?.dispose()
  bridge = null
})

function wiring(over: Partial<AcpBridgeWiring> = {}): AcpBridgeWiring {
  const emulator = Object.assign(new EventEmitter(), {
    getStatus: () => ({ state: 'idle' }),
    start: vi.fn(),
    lastFirmware: vi.fn(() => null),
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
      open: vi.fn(async (dir: string) => ({ dir, name: 'p', envs: [] })),
      readFile: vi.fn(async () => ''),
      actions: vi.fn(async () => []),
      rootDir: () => '/home/u/proj',
      clean: vi.fn()
    },
    menuCommand: vi.fn(),
    confirm: vi.fn(async () => true),
    // No agent command in tests unless a case sets one.
    agent: null,
    ...over
  }
}

async function callTool(url: string, token: string, name: string, args: unknown = {}) {
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

describe('startAcpBridge', () => {
  it('serves board_verify from the main-held board without a prompt', async () => {
    const w = wiring()
    bridge = await startAcpBridge(w)
    const out = await callTool(bridge.server.url, bridge.server.token, 'board_verify')
    expect(out.result.isError).toBeUndefined()
    expect(w.confirm).not.toHaveBeenCalled()
  })

  it('buffers serial and returns the tail via serial_read', async () => {
    const w = wiring()
    bridge = await startAcpBridge(w)
    ;(w.emulator as unknown as EventEmitter).emit('serial', [
      { t: 1, text: 'one' },
      { t: 2, text: 'two' }
    ])
    const out = await callTool(bridge.server.url, bridge.server.token, 'serial_read', { limit: 1 })
    expect(out.result.structuredContent).toEqual({ lines: [{ t: 2, text: 'two' }] })
  })

  it('prompts via confirm() before an exec op and refuses on a no', async () => {
    const confirm = vi.fn(async () => false)
    const w = wiring({ confirm })
    bridge = await startAcpBridge(w)
    const out = await callTool(bridge.server.url, bridge.server.token, 'emulator_reset')
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ name: 'emulator_reset' }))
    expect(out.result.isError).toBe(true)
    expect(
      (w.emulator as unknown as { reset: ReturnType<typeof vi.fn> }).reset
    ).not.toHaveBeenCalled()
  })

  it('skips confirm() for exec ops while autoApprove() is true', async () => {
    const confirm = vi.fn(async () => false)
    const w = wiring({ confirm, autoApprove: () => true })
    bridge = await startAcpBridge(w)
    const out = await callTool(bridge.server.url, bridge.server.token, 'emulator_reset')
    expect(confirm).not.toHaveBeenCalled()
    expect(out.result.isError).toBeUndefined()
    expect((w.emulator as unknown as { reset: ReturnType<typeof vi.fn> }).reset).toHaveBeenCalled()
  })

  it('runs an exec op after confirm() approves', async () => {
    const w = wiring()
    bridge = await startAcpBridge(w)
    await callTool(bridge.server.url, bridge.server.token, 'emulator_reset')
    expect((w.emulator as unknown as { reset: ReturnType<typeof vi.fn> }).reset).toHaveBeenCalled()
  })

  it('board_edit mutates the main-held history and re-syncs the device host', async () => {
    const w = wiring()
    bridge = await startAcpBridge(w)
    const part = board.parts[0]!
    const edit = { kind: 'moveParty', partId: part.id, x: 99, y: 88 }

    const applied = await callTool(bridge.server.url, bridge.server.token, 'board_edit', { edit })
    expect(applied.result.isError).toBeUndefined()
    expect(w.onBoardChanged).toHaveBeenCalledTimes(1)
    expect((w.devices as unknown as { load: ReturnType<typeof vi.fn> }).load).toHaveBeenCalledTimes(
      1
    )

    const after = (await callTool(bridge.server.url, bridge.server.token, 'board_get')).result
      .structuredContent as { parts: { id: string; layout: { x: number; y: number } }[] }
    expect(after.parts.find((p) => p.id === part.id)!.layout).toMatchObject({ x: 99, y: 88 })

    await callTool(bridge.server.url, bridge.server.token, 'board_undo')
    const undone = (await callTool(bridge.server.url, bridge.server.token, 'board_get')).result
      .structuredContent as { parts: { id: string; layout: { x: number; y: number } }[] }
    expect(undone.parts.find((p) => p.id === part.id)!.layout).toMatchObject(part.layout)
  })

  it('board_edit surfaces a bad reference as an error result', async () => {
    const w = wiring()
    bridge = await startAcpBridge(w)
    const out = await callTool(bridge.server.url, bridge.server.token, 'board_edit', {
      edit: { kind: 'moveParty', partId: 'nonesuch', x: 0, y: 0 }
    })
    expect(out.result.isError).toBe(true)
    expect(w.onBoardChanged).not.toHaveBeenCalled()
  })

  it('a bad agent command does not hang startup or leak the child', async () => {
    const w = wiring({
      agent: { command: 'pinbench-no-such-agent-binary-xyz', args: [] },
      agentStartTimeoutMs: 500
    })
    // Resolves quickly despite the doomed spawn.
    bridge = await startAcpBridge(w)
    await bridge.ready
    expect(bridge.session).toBeNull()
    await expect(bridge.prompt('hi')).rejects.toThrow(/no agent is running/)
    // dispose must not throw or hang.
    await bridge.dispose()
    bridge = null
  })
})
