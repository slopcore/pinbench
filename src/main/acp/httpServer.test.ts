import { afterEach, describe, expect, it, vi } from 'vitest'
import { operation } from '../../shared/acp/operations'
import { startAcpControlServer, type AcpControlServerHandle } from './httpServer'

let handle: AcpControlServerHandle | null = null

afterEach(async () => {
  await handle?.close()
  handle = null
})

const rpc = (method: string, params?: unknown, id = 1) =>
  JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })

async function post(
  h: AcpControlServerHandle,
  body: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(h.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${h.token}`, ...headers },
    body
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

describe('startAcpControlServer', () => {
  it('binds loopback and serves tools/list to an authorised caller', async () => {
    handle = await startAcpControlServer({
      serverName: 'pinbench',
      serverVersion: '0.1.0',
      invoke: async (op) => op.name,
      authorize: async () => true
    })
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)

    const { status, json } = await post(handle, rpc('tools/list'))
    expect(status).toBe(200)
    expect((json as { result: { tools: unknown[] } }).result.tools.length).toBeGreaterThan(0)
  })

  it('rejects a missing or wrong bearer token with 403 and no body', async () => {
    handle = await startAcpControlServer({
      serverName: 'pinbench',
      serverVersion: '0.1.0',
      invoke: async () => null
    })
    const res = await fetch(handle.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rpc('tools/list')
    })
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('')

    const wrong = await post(handle, rpc('tools/list'), { authorization: 'Bearer nope' })
    expect(wrong.status).toBe(403)
  })

  it('rejects a non-loopback Origin', async () => {
    handle = await startAcpControlServer({
      serverName: 'pinbench',
      serverVersion: '0.1.0',
      invoke: async () => null,
      authorize: async () => true
    })
    const { status } = await post(handle, rpc('tools/list'), { origin: 'https://evil.example' })
    expect(status).toBe(403)
  })

  it('routes tools/call through invoke and returns the JSON-RPC result', async () => {
    const invoke = vi.fn(async (op) => ({ did: op.name }))
    handle = await startAcpControlServer({
      serverName: 'pinbench',
      serverVersion: '0.1.0',
      invoke,
      authorize: async () => true
    })
    const { json } = await post(handle, rpc('tools/call', { name: 'app_info', arguments: {} }))
    expect(invoke).toHaveBeenCalledWith(operation('app_info'), {})
    expect((json as { result: { structuredContent: unknown } }).result.structuredContent).toEqual({
      did: 'app_info'
    })
  })

  it('fails closed on an exec op when no authorizer is wired', async () => {
    handle = await startAcpControlServer({
      serverName: 'pinbench',
      serverVersion: '0.1.0',
      invoke: async () => 'ran'
    })
    const { json } = await post(
      handle,
      rpc('tools/call', { name: 'build_start', arguments: { env: 'm9' } })
    )
    const result = (json as { result: { isError?: boolean; content: { text: string }[] } }).result
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/Permission denied/)
  })

  it('answers a parse error with a JSON-RPC error frame', async () => {
    handle = await startAcpControlServer({
      serverName: 'pinbench',
      serverVersion: '0.1.0',
      invoke: async () => null,
      authorize: async () => true
    })
    const { status, json } = await post(handle, '{not json')
    expect(status).toBe(200)
    expect((json as { error: { code: number } }).error.code).toBe(-32700)
  })
})
