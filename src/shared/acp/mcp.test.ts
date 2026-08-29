import { describe, expect, it, vi } from 'vitest'
import { Dispatcher } from './dispatch'
import { MCP_PROTOCOL_VERSION } from './methods'
import { mcpHandlers, type McpToolResult } from './mcp'
import { OPERATIONS } from './operations'

const server = (over: Partial<Parameters<typeof mcpHandlers>[0]> = {}) =>
  new Dispatcher(
    mcpHandlers({
      serverName: 'pinbench',
      serverVersion: '0.1.0',
      invoke: async (op, params) => ({ ran: op.name, params }),
      ...over
    })
  )

const call = async (d: Dispatcher, name: string, args?: unknown) => {
  const res = await d.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args }
  })
  return (res as { result: McpToolResult }).result
}

describe('mcp initialize / tools/list', () => {
  it('reports the protocol version and tools capability', async () => {
    const res = await server().handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(res).toMatchObject({
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'pinbench', version: '0.1.0' }
      }
    })
  })

  it('lists one tool per operation with a schema', async () => {
    const res = await server().handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    const tools = (res as { result: { tools: { name: string; inputSchema: unknown }[] } }).result
      .tools
    expect(tools).toHaveLength(OPERATIONS.length)
    expect(tools.every((t) => t.inputSchema && typeof t.inputSchema === 'object')).toBe(true)
  })

  it('answers ping with an empty object', async () => {
    const res = await server().handle({ jsonrpc: '2.0', id: 2, method: 'ping' })
    expect(res).toEqual({ jsonrpc: '2.0', id: 2, result: {} })
  })
})

describe('tools/call', () => {
  it('validates params then invokes, returning text and structuredContent', async () => {
    const d = server()
    const result = await call(d, 'serial_write', { text: 'hello' })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ ran: 'serial_write', params: { text: 'hello' } })
    expect(result.content[0]!.type).toBe('text')
  })

  it('returns an error result (not a throw) for an unknown tool', async () => {
    const result = await call(server(), 'no_such_tool', {})
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/Unknown tool/)
  })

  it('returns an error result when required params are missing', async () => {
    const result = await call(server(), 'serial_write', {})
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/requires "text"/)
  })

  it('surfaces an invoker failure as an error result', async () => {
    const d = server({
      invoke: async () => {
        throw new Error('emulator not running')
      }
    })
    const result = await call(d, 'emulator_reset')
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toBe('emulator not running')
  })

  it('consults the authorizer for exec ops and refuses on a false', async () => {
    const authorize = vi.fn(async () => false)
    const invoke = vi.fn(async () => 'ran')
    const d = server({ authorize, invoke })
    const result = await call(d, 'build_start', { env: 'm9' })
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ name: 'build_start' }), {
      env: 'm9'
    })
    expect(invoke).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/Permission denied/)
  })

  it('runs the op when the authorizer allows it', async () => {
    const d = server({ authorize: async () => true })
    const result = await call(d, 'build_start', { env: 'm9' })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ ran: 'build_start' })
  })
})
