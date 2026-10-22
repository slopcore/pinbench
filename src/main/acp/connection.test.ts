import { describe, expect, it, vi } from 'vitest'
import { AcpConnection, AcpConnectionError } from './connection'
import { transportPair } from './testTransport'

describe('AcpConnection', () => {
  it('carries a request to the peer handler and resolves with its result', async () => {
    const { a, b } = transportPair()
    new AcpConnection(b, { add: (p) => (p as number[]).reduce((x, y) => x + y, 0) })
    const client = new AcpConnection(a)
    expect(await client.request('add', [2, 3, 4])).toBe(9)
  })

  it('rejects with the peer error code and message', async () => {
    const { a, b } = transportPair()
    new AcpConnection(b, {
      boom: () => {
        throw new AcpConnectionError('nope', 123)
      }
    })
    const client = new AcpConnection(a)
    await expect(client.request('boom')).rejects.toMatchObject({ message: 'nope' })
  })

  it('returns method-not-found for an unknown request', async () => {
    const { a, b } = transportPair()
    new AcpConnection(b, {})
    const client = new AcpConnection(a)
    await expect(client.request('missing')).rejects.toMatchObject({ code: -32601 })
  })

  it('delivers a notification without expecting a reply', async () => {
    const { a, b } = transportPair()
    const seen = vi.fn()
    new AcpConnection(b, { 'session/cancel': (p) => seen(p) })
    const client = new AcpConnection(a)
    client.notify('session/cancel', { sessionId: 's1' })
    await new Promise((r) => setTimeout(r, 5))
    expect(seen).toHaveBeenCalledWith({ sessionId: 's1' })
  })

  it('rejects every pending request when the transport closes', async () => {
    const { a, b } = transportPair()
    new AcpConnection(b, { slow: () => new Promise(() => {}) })
    const client = new AcpConnection(a)
    const pending = client.request('slow')
    client.close()
    await expect(pending).rejects.toBeInstanceOf(AcpConnectionError)
  })

  it('interleaves requests in both directions', async () => {
    const { a, b } = transportPair()
    const ref: { server?: AcpConnection } = {}
    ref.server = new AcpConnection(b, {
      // call back into the client mid-request
      ping: async (): Promise<{ echoed: unknown }> => ({
        echoed: await ref.server!.request('whoami')
      })
    })
    const client = new AcpConnection(a, { whoami: () => 'client' })
    expect(await client.request('ping')).toEqual({ echoed: 'client' })
  })
})
