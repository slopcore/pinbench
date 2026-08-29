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
    reset: vi.fn(),
    stop: vi.fn(),
    writeSerial: vi.fn()
  })
  const devices = Object.assign(new EventEmitter(), { command: vi.fn() })
  return {
    appVersion: '0.1.0',
    platform: 'darwin',
    isDev: true,
    emulator: emulator as never,
    build: { getStatus: () => ({ state: 'idle' }), cancel: vi.fn() },
    devices: devices as never,
    getBoard: () => board,
    project: {
      open: vi.fn(async (dir: string) => ({ dir, name: 'p', envs: [] })),
      readTree: vi.fn(async () => []),
      readFile: vi.fn(async () => ''),
      clean: vi.fn()
    },
    menuCommand: vi.fn(),
    confirm: vi.fn(async () => true),
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

  it('runs an exec op after confirm() approves', async () => {
    const w = wiring()
    bridge = await startAcpBridge(w)
    await callTool(bridge.server.url, bridge.server.token, 'emulator_reset')
    expect((w.emulator as unknown as { reset: ReturnType<typeof vi.fn> }).reset).toHaveBeenCalled()
  })
})
