/**
 * The host side of {@link NetBackend}: real `node:net` / `node:dgram` sockets
 * behind a slirp-shaped guest network (see `shared/devices/net.ts`).
 *
 *   - 10.0.2.2 (the gateway) is this machine: connects and datagrams go to
 *     127.0.0.1, and traffic from 127.0.0.1 is reported as coming from it.
 *   - 10.0.2.3:53 (DNS) is relayed to the first IPv4 resolver Node knows.
 *   - Anything else is routed as-is, so the guest reaches the internet.
 *
 * Guest UDP ports are not bound on the host (a guest on :68 or :53 would need
 * privileges); each guest socket gets an ephemeral host port. A guest TCP
 * LISTEN port is bound on 127.0.0.1 — the same number, or +8000 below 1024,
 * or any free port if that is taken.
 */

import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { getServers } from 'node:dns'
import { connect, createServer, type Socket } from 'node:net'
import {
  GUEST_NET,
  ipBytes,
  ipString,
  type Ipv4,
  type NetBackend,
  type TcpEvents,
  type TcpHandle,
  type TcpListener,
  type UdpHandle
} from '../shared/devices/net'

const LOCALHOST = '127.0.0.1'
const DNS_PORT = 53
const FALLBACK_RESOLVER = '1.1.1.1'

function sameIp(a: Ipv4, b: Ipv4): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]
}

function resolver(): string {
  try {
    return getServers().find((s) => /^\d+\.\d+\.\d+\.\d+$/.test(s)) ?? FALLBACK_RESOLVER
  } catch {
    return FALLBACK_RESOLVER
  }
}

/** Guest destination → host destination. */
function outbound(ip: Ipv4, port: number): { host: string; port: number } {
  if (sameIp(ip, GUEST_NET.gateway)) return { host: LOCALHOST, port }
  if (sameIp(ip, GUEST_NET.dns) && port === DNS_PORT) return { host: resolver(), port }
  return { host: ipString(ip), port }
}

/** A host-side address as the guest should see it. */
function inbound(address: string): number[] {
  const v4 = address.replace(/^::ffff:/, '')
  return v4 === LOCALHOST ? [...GUEST_NET.gateway] : ipBytes(v4)
}

function wrap(socket: Socket): TcpHandle {
  return {
    write: (data) => {
      if (!socket.destroyed) socket.write(data)
    },
    end: () => socket.end(),
    destroy: () => socket.destroy(),
    pause: () => socket.pause(),
    resume: () => socket.resume()
  }
}

function wire(socket: Socket, events: TcpEvents): void {
  socket.on('data', (chunk: Buffer) => events.onData(new Uint8Array(chunk)))
  socket.on('close', (hadError) => events.onClose(hadError))
  // 'close' always follows; an unhandled 'error' would crash the main process.
  socket.on('error', () => undefined)
}

export class NodeNetBackend implements NetBackend {
  udpOpen(
    _port: number,
    onMessage: (srcIp: Ipv4, srcPort: number, data: Uint8Array) => void
  ): UdpHandle {
    const socket: UdpSocket = createSocket('udp4')
    const dns = resolver()
    socket.on('message', (msg, rinfo) => {
      const fromDns = rinfo.address === dns && rinfo.port === DNS_PORT
      onMessage(
        fromDns ? [...GUEST_NET.dns] : inbound(rinfo.address),
        rinfo.port,
        new Uint8Array(msg)
      )
    })
    socket.on('error', () => undefined)
    let ready = false
    const queue: Array<() => void> = []
    socket.bind(0, () => {
      socket.setBroadcast(true)
      ready = true
      for (const send of queue.splice(0)) send()
    })
    return {
      send: (ip, port, data) => {
        const to =
          sameIp(ip, GUEST_NET.dns) && port === DNS_PORT ? { host: dns, port } : outbound(ip, port)
        const go = (): void => socket.send(data, to.port, to.host, () => undefined)
        if (ready) go()
        else queue.push(go)
      },
      close: () => {
        try {
          socket.close()
        } catch {
          // already closed
        }
      }
    }
  }

  tcpConnect(ip: Ipv4, port: number, events: TcpEvents): TcpHandle {
    const to = outbound(ip, port)
    const socket = connect({ host: to.host, port: to.port })
    socket.setNoDelay(true)
    socket.once('connect', () => events.onConnect?.())
    wire(socket, events)
    return wrap(socket)
  }

  tcpListen(
    port: number,
    onAccept: (handle: TcpHandle, peerIp: Ipv4, peerPort: number) => TcpEvents | null,
    onListening?: (hostPort: number) => void
  ): TcpListener {
    const server = createServer((socket) => {
      socket.setNoDelay(true)
      const events = onAccept(
        wrap(socket),
        inbound(socket.remoteAddress ?? LOCALHOST),
        socket.remotePort ?? 0
      )
      if (!events) {
        socket.destroy()
        return
      }
      wire(socket, events)
    })
    const listener = {
      hostPort: port < 1024 ? port + 8000 : port,
      close: () => server.close()
    }
    server.on('listening', () => {
      const address = server.address()
      if (address && typeof address === 'object') listener.hostPort = address.port
      onListening?.(listener.hostPort)
    })
    server.on('error', (error: NodeJS.ErrnoException) => {
      // Taken: fall back to any free port and say which.
      if (error.code === 'EADDRINUSE') server.listen(0, LOCALHOST)
    })
    server.listen(listener.hostPort, LOCALHOST)
    return listener
  }
}
