// @vitest-environment node
import { createSocket } from 'node:dgram'
import { connect, createServer, type AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { NodeNetBackend } from './net-backend'

const GATEWAY = [10, 0, 2, 2]

describe('NodeNetBackend', () => {
  it('a guest TCP connect to the gateway reaches a localhost server', async () => {
    const server = createServer((s) => s.end('hello guest'))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port
    const got = await new Promise<{ connected: boolean; data: string }>((resolve) => {
      let connected = false
      let data = ''
      new NodeNetBackend().tcpConnect(GATEWAY, port, {
        onConnect: () => (connected = true),
        onData: (d) => (data += Buffer.from(d).toString()),
        onClose: () => resolve({ connected, data })
      })
    })
    server.close()
    expect(got).toEqual({ connected: true, data: 'hello guest' })
  })

  it('a refused connect closes with an error and never connects', async () => {
    const server = createServer()
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port
    await new Promise<void>((r) => server.close(() => r()))
    const result = await new Promise<{ connected: boolean; hadError: boolean }>((resolve) => {
      let connected = false
      new NodeNetBackend().tcpConnect(GATEWAY, port, {
        onConnect: () => (connected = true),
        onData: () => undefined,
        onClose: (hadError) => resolve({ connected, hadError })
      })
    })
    expect(result).toEqual({ connected: false, hadError: true })
  })

  it('a guest LISTEN port accepts a host client, reported as from the gateway', async () => {
    const backend = new NodeNetBackend()
    let peer: number[] = []
    const hostPort = await new Promise<number>((resolve) => {
      backend.tcpListen(
        0,
        (handle, ip) => {
          peer = [...ip]
          return {
            onData: (d) => handle.write(Uint8Array.from([...d].reverse())),
            onClose: () => undefined
          }
        },
        resolve
      )
    })
    const reply = await new Promise<string>((resolve) => {
      const client = connect(hostPort, '127.0.0.1', () => client.write('abc'))
      client.on('data', (d) => {
        resolve(d.toString())
        client.destroy()
      })
    })
    expect(reply).toBe('cba')
    expect(peer).toEqual(GATEWAY)
  })

  it('a guest datagram to the gateway reaches localhost and the answer comes back', async () => {
    const echo = createSocket('udp4')
    await new Promise<void>((r) => echo.bind(0, '127.0.0.1', () => r()))
    echo.on('message', (msg, rinfo) => echo.send(msg, rinfo.port, rinfo.address))
    const port = echo.address().port
    const got = await new Promise<{ ip: number[]; port: number; data: string }>((resolve) => {
      const udp = new NodeNetBackend().udpOpen(5000, (ip, srcPort, data) => {
        resolve({ ip: [...ip], port: srcPort, data: Buffer.from(data).toString() })
        udp.close()
      })
      udp.send(GATEWAY, port, Uint8Array.from(Buffer.from('ping')))
    })
    echo.close()
    expect(got).toEqual({ ip: GATEWAY, port, data: 'ping' })
  })
})
