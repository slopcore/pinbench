import { describe, expect, it } from 'vitest'
import {
  NdjsonBuffer,
  RpcError,
  RpcErrorCode,
  encodeFrame,
  errorResponse,
  isNotification,
  isRequest,
  isResponse,
  parseFrame,
  resultResponse
} from './jsonrpc'

describe('message discrimination', () => {
  it('recognises a request', () => {
    const m = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
    expect(isRequest(m)).toBe(true)
    expect(isNotification(m)).toBe(false)
    expect(isResponse(m)).toBe(false)
  })

  it('recognises a notification by the absent id', () => {
    const m = { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'x' } }
    expect(isNotification(m)).toBe(true)
    expect(isRequest(m)).toBe(false)
  })

  it('recognises both result and error responses', () => {
    expect(isResponse({ jsonrpc: '2.0', id: 1, result: null })).toBe(true)
    expect(isResponse({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'x' } })).toBe(true)
  })

  it('rejects a wrong jsonrpc version and a string id-less object', () => {
    expect(isRequest({ jsonrpc: '1.0', id: 1, method: 'x' })).toBe(false)
    expect(isResponse({ jsonrpc: '2.0', result: null })).toBe(false)
  })
})

describe('response builders', () => {
  it('coerces an undefined result to null', () => {
    expect(resultResponse(7, undefined)).toEqual({ jsonrpc: '2.0', id: 7, result: null })
  })

  it('omits data when not supplied', () => {
    expect(errorResponse(1, RpcErrorCode.methodNotFound, 'Method not found')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'Method not found' }
    })
  })

  it('carries data when supplied', () => {
    expect(errorResponse(1, -32602, 'Invalid params', { field: 'x' }).error.data).toEqual({
      field: 'x'
    })
  })
})

describe('RpcError', () => {
  it('methodNotFound names the method in data', () => {
    const e = RpcError.methodNotFound('foo/bar')
    expect(e.code).toBe(RpcErrorCode.methodNotFound)
    expect(e.data).toEqual({ method: 'foo/bar' })
  })
})

describe('parseFrame', () => {
  it('parses a valid request', () => {
    const r = parseFrame('{"jsonrpc":"2.0","id":1,"method":"ping"}')
    expect(r.ok).toBe(true)
  })

  it('returns a null-id parse error on bad JSON', () => {
    const r = parseFrame('{not json')
    expect(r).toEqual({
      ok: false,
      error: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }
    })
  })

  it('returns an invalid-request error and keeps a usable id', () => {
    const r = parseFrame('{"jsonrpc":"2.0","id":9}')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.id).toBe(9)
      expect(r.error.error.code).toBe(RpcErrorCode.invalidRequest)
    }
  })
})

describe('NdjsonBuffer', () => {
  it('returns complete lines and buffers the partial tail', () => {
    const b = new NdjsonBuffer()
    expect(b.push('{"a":1}\n{"b":2}')).toEqual(['{"a":1}'])
    expect(b.push('\n{"c":3}')).toEqual(['{"b":2}'])
    expect(b.flush()).toBe('{"c":3}')
  })

  it('strips a trailing CR and drops blank lines', () => {
    const b = new NdjsonBuffer()
    expect(b.push('one\r\n\r\ntwo\r\n')).toEqual(['one', 'two'])
  })

  it('flush returns null when the buffer holds nothing', () => {
    expect(new NdjsonBuffer().flush()).toBeNull()
  })

  it('round-trips through encodeFrame', () => {
    const b = new NdjsonBuffer()
    const frame = encodeFrame(resultResponse(1, { ok: true }))
    expect(b.push(frame)).toEqual(['{"jsonrpc":"2.0","id":1,"result":{"ok":true}}'])
  })
})
