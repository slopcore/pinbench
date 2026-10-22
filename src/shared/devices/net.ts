/**
 * The host network a device model can borrow — the seam between a
 * hardwired-TCP/IP part (the WIZnet W5500) and real sockets.
 *
 * Models live in `shared/` and must not import Node, so the device host lends
 * them a {@link NetBackend} through {@link DeviceContext.net}; the main
 * process implements it with `node:net` / `node:dgram`
 * (`src/main/net-backend.ts`), and tests hand in a fake.
 *
 * The guest sees a slirp-shaped private network, so firmware written for
 * QEMU's user-mode network (and PinBench's openeth path) finds the same
 * addresses:
 *
 *   - {@link GUEST_NET.gateway} `10.0.2.2` — the host itself; a TCP connect
 *     there reaches `127.0.0.1`.
 *   - {@link GUEST_NET.dns} `10.0.2.3` — UDP/53 is forwarded to the host's
 *     resolver.
 *   - {@link GUEST_NET.guest} `10.0.2.15` — what DHCP hands out.
 */

export const GUEST_NET = {
  guest: [10, 0, 2, 15],
  gateway: [10, 0, 2, 2],
  dns: [10, 0, 2, 3],
  netmask: [255, 255, 255, 0]
} as const

export type Ipv4 = readonly [number, number, number, number] | readonly number[]

export function ipString(ip: Ipv4): string {
  return `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}`
}

export function ipBytes(text: string): number[] {
  const parts = text.split('.').map((p) => Number(p))
  return parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)
    ? parts
    : [0, 0, 0, 0]
}

/** A bound UDP port. */
export interface UdpHandle {
  send(ip: Ipv4, port: number, data: Uint8Array): void
  close(): void
}

/** One TCP stream, outbound or accepted. */
export interface TcpHandle {
  write(data: Uint8Array): void
  /** Half-close: send FIN once queued data has gone. */
  end(): void
  /** Abort (RST) and release. */
  destroy(): void
  /** Stop delivering `onData` until {@link resume} — receive-window backpressure. */
  pause(): void
  resume(): void
}

export interface TcpEvents {
  onConnect?(): void
  onData(data: Uint8Array): void
  /** The peer closed its side (FIN) or the stream died. */
  onClose(hadError: boolean): void
}

export interface TcpListener {
  /** The host port actually bound — may differ from the guest's (privileged ports). */
  readonly hostPort: number
  close(): void
}

export interface NetBackend {
  udpOpen(
    port: number,
    onMessage: (srcIp: Ipv4, srcPort: number, data: Uint8Array) => void
  ): UdpHandle
  tcpConnect(ip: Ipv4, port: number, events: TcpEvents): TcpHandle
  /**
   * Accept TCP connections for guest port `port`. `onAccept` adopts each
   * connection and returns its event sink, or `null` to refuse it (no socket
   * is listening any more). `onListening` reports the host port bound.
   */
  tcpListen(
    port: number,
    onAccept: (handle: TcpHandle, peerIp: Ipv4, peerPort: number) => TcpEvents | null,
    onListening?: (hostPort: number) => void
  ): TcpListener
}
