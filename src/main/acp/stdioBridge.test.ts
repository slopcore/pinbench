/**
 * `scripts/pinbench-mcp.mjs` — the stdio↔loopback-HTTP shim an MCP client that
 * only speaks the `Stdio` transport spawns to reach PinBench's control server
 * (roadmap M16.4). Exercised end to end: a real {@link startAcpControlServer},
 * the real script as a child process, JSON-RPC lines over its stdio.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NdjsonBuffer } from '../../shared/acp/jsonrpc'
import { OPERATIONS } from '../../shared/acp/operations'
import { startAcpControlServer, type AcpControlServerHandle } from './httpServer'

const SCRIPT = resolve(__dirname, '../../../scripts/pinbench-mcp.mjs')

describe('pinbench-mcp stdio bridge', () => {
  let server: AcpControlServerHandle
  let tmp: string
  let child: ChildProcessWithoutNullStreams
  let lines: NdjsonBuffer
  let queue: string[]
  let waiters: Array<(line: string) => void>

  beforeEach(async () => {
    server = await startAcpControlServer({
      serverName: 'pinbench',
      serverVersion: '0.0.0-test',
      invoke: async (op) => ({ ok: op.name }),
      authorize: async () => true
    })
    tmp = mkdtempSync(join(tmpdir(), 'pinbench-acp-'))
    const infoPath = join(tmp, 'acp.json')
    writeFileSync(infoPath, JSON.stringify({ url: server.url, token: server.token }), 'utf8')

    child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, PINBENCH_ACP_INFO: infoPath },
      stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams

    lines = new NdjsonBuffer()
    queue = []
    waiters = []
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      for (const line of lines.push(chunk)) {
        const waiter = waiters.shift()
        if (waiter) waiter(line)
        else queue.push(line)
      }
    })
  })

  afterEach(async () => {
    child.kill()
    await server.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  const send = (frame: unknown): void => {
    child.stdin.write(JSON.stringify(frame) + '\n')
  }

  const nextLine = (): Promise<string> =>
    new Promise((res) => {
      const queued = queue.shift()
      if (queued !== undefined) res(queued)
      else waiters.push(res)
    })

  it('forwards a request and relays the response frame', async () => {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const reply = JSON.parse(await nextLine())
    expect(reply.id).toBe(1)
    expect(reply.result).toMatchObject({ protocolVersion: expect.any(String) })
  })

  it('lists one tool per PinBench operation', async () => {
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const reply = JSON.parse(await nextLine())
    expect(reply.id).toBe(2)
    expect(reply.result.tools).toHaveLength(OPERATIONS.length)
  })

  it('relays a tools/call result', async () => {
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'app_info', arguments: {} }
    })
    const reply = JSON.parse(await nextLine())
    expect(reply.id).toBe(3)
    expect(reply.result.isError).toBeFalsy()
  })

  it('writes nothing for a notification, then still answers the next request', async () => {
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 4, method: 'ping', params: {} })
    const reply = JSON.parse(await nextLine())
    expect(reply.id).toBe(4)
  })

  it('exits cleanly when stdin closes', async () => {
    child.stdin.end()
    const code: number = await new Promise((res) => child.on('exit', (c) => res(c ?? -1)))
    expect(code).toBe(0)
  })
})
