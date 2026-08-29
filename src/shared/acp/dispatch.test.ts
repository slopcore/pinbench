import { describe, expect, it, vi } from 'vitest'
import { Dispatcher } from './dispatch'
import { RpcError, RpcErrorCode } from './jsonrpc'

const req = (id: number, method: string, params?: unknown) => ({
  jsonrpc: '2.0' as const,
  id,
  method,
  ...(params === undefined ? {} : { params })
})

describe('Dispatcher', () => {
  it('routes a request to its handler and wraps the result', async () => {
    const d = new Dispatcher({ add: (p) => (p as number[]).reduce((a, b) => a + b, 0) })
    expect(await d.handle(req(1, 'add', [2, 3]))).toEqual({ jsonrpc: '2.0', id: 1, result: 5 })
  })

  it('awaits an async handler', async () => {
    const d = new Dispatcher({ slow: async () => 'done' })
    expect(await d.handle(req(1, 'slow'))).toEqual({ jsonrpc: '2.0', id: 1, result: 'done' })
  })

  it('coerces an undefined return to a null result', async () => {
    const d = new Dispatcher({ noop: () => undefined })
    expect(await d.handle(req(1, 'noop'))).toEqual({ jsonrpc: '2.0', id: 1, result: null })
  })

  it('returns method-not-found for an unknown request method', async () => {
    const d = new Dispatcher({})
    expect(await d.handle(req(1, 'nope'))).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: RpcErrorCode.methodNotFound,
        message: 'Method not found',
        data: { method: 'nope' }
      }
    })
  })

  it('passes an RpcError through with its code and data', async () => {
    const d = new Dispatcher({
      bad: () => {
        throw new RpcError(RpcErrorCode.invalidParams, 'Invalid params: x', { field: 'x' })
      }
    })
    const res = await d.handle(req(1, 'bad'))
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: RpcErrorCode.invalidParams,
        message: 'Invalid params: x',
        data: { field: 'x' }
      }
    })
  })

  it('wraps a plain throw as an internal error carrying the message', async () => {
    const d = new Dispatcher({
      boom: () => {
        throw new Error('kaboom')
      }
    })
    const res = await d.handle(req(1, 'boom'))
    expect(res).toMatchObject({
      id: 1,
      error: { code: RpcErrorCode.internalError, message: 'kaboom' }
    })
  })

  it('returns null for a notification, and still runs its handler', async () => {
    const spy = vi.fn()
    const d = new Dispatcher({ 'session/cancel': spy })
    expect(
      await d.handle({ jsonrpc: '2.0', method: 'session/cancel', params: { s: 1 } })
    ).toBeNull()
    expect(spy).toHaveBeenCalledWith({ s: 1 })
  })

  it('swallows an unknown notification method without erroring', async () => {
    const d = new Dispatcher({})
    expect(await d.handle({ jsonrpc: '2.0', method: 'whatever' })).toBeNull()
  })

  it('on() registers and replaces handlers', async () => {
    const d = new Dispatcher()
    d.on('x', () => 1).on('x', () => 2)
    expect(d.has('x')).toBe(true)
    expect(await d.handle(req(1, 'x'))).toEqual({ jsonrpc: '2.0', id: 1, result: 2 })
  })
})
