import { describe, expect, it } from 'vitest'
import { DeviceHarness } from './harness'
import type { DeviceModel } from './model'
import type { Ipv4, NetBackend, TcpEvents, TcpHandle } from './net'
import { dhcpMessageType } from './dhcp'
import { SR, W5500_VERSION, W5500Model } from './w5500'

/** A scripted host network that records what the model asked of it. */
class FakeNet implements NetBackend {
  udpSent: Array<{ ip: string; port: number; data: number[] }> = []
  udpPorts = new Map<number, (ip: Ipv4, port: number, data: Uint8Array) => void>()
  tcp: Array<{ ip: string; port: number; events: TcpEvents; written: number[]; ended: boolean }> =
    []
  accept: ((h: TcpHandle, ip: Ipv4, port: number) => TcpEvents | null) | null = null
  paused = false

  udpOpen(port: number, onMessage: (ip: Ipv4, port: number, data: Uint8Array) => void) {
    this.udpPorts.set(port, onMessage)
    return {
      send: (ip: Ipv4, p: number, data: Uint8Array) =>
        this.udpSent.push({ ip: ip.join('.'), port: p, data: [...data] }),
      close: () => this.udpPorts.delete(port)
    }
  }

  tcpConnect(ip: Ipv4, port: number, events: TcpEvents): TcpHandle {
    const rec = { ip: ip.join('.'), port, events, written: [] as number[], ended: false }
    this.tcp.push(rec)
    return this.handle(rec)
  }

  destroyed = 0

  handle(rec: { written: number[]; ended: boolean }): TcpHandle {
    return {
      write: (d) => rec.written.push(...d),
      end: () => (rec.ended = true),
      destroy: () => this.destroyed++,
      pause: () => (this.paused = true),
      resume: () => (this.paused = false)
    }
  }

  tcpListen(
    _port: number,
    onAccept: (h: TcpHandle, ip: Ipv4, port: number) => TcpEvents | null,
    onListening?: (hostPort: number) => void
  ) {
    this.accept = onAccept
    onListening?.(_port + 8000)
    return { hostPort: _port + 8000, close: () => undefined }
  }
}

const COMMON = 0
const sock = (n: number): number => n * 4 + 1
const txb = (n: number): number => n * 4 + 2
const rxb = (n: number): number => n * 4 + 3

class W5500Bus {
  readonly h: DeviceHarness
  constructor(model: DeviceModel, net?: NetBackend) {
    this.h = new DeviceHarness(model, net ? { net } : {})
  }

  /** One CS-framed access, optionally split into chunks the way an SPI FIFO drains. */
  private frame(bytes: number[], chunk = 0): Uint8Array {
    this.h.signal('CS', 0)
    const out: number[] = []
    const size = chunk || bytes.length
    for (let i = 0; i < bytes.length; i += size) {
      out.push(
        ...this.h.bus({
          bus: 'spi-eth',
          kind: 'spi',
          mosi: Uint8Array.from(bytes.slice(i, i + size))
        })
      )
    }
    this.h.signal('CS', 1)
    return Uint8Array.from(out)
  }

  write(bsb: number, addr: number, data: number[], chunk = 0): void {
    this.frame([addr >> 8, addr & 0xff, (bsb << 3) | 0x04, ...data], chunk)
  }

  read(bsb: number, addr: number, len: number, chunk = 0): number[] {
    return [
      ...this.frame([addr >> 8, addr & 0xff, bsb << 3, ...new Array(len).fill(0)], chunk)
    ].slice(3)
  }

  read16(bsb: number, addr: number): number {
    const [hi, lo] = this.read(bsb, addr, 2)
    return (hi! << 8) | lo!
  }

  write16(bsb: number, addr: number, value: number): void {
    this.write(bsb, addr, [value >> 8, value & 0xff])
  }

  cmd(n: number, cr: number): void {
    this.write(sock(n), 0x01, [cr])
  }

  status(n: number): number {
    return this.read(sock(n), 0x03, 1)[0]!
  }

  /** Queue `data` in socket n's TX ring and SEND it, as the Arduino library does. */
  send(n: number, data: number[]): void {
    const wr = this.read16(sock(n), 0x24)
    this.write(txb(n), wr, data)
    this.write16(sock(n), 0x24, (wr + data.length) & 0xffff)
    this.cmd(n, 0x20)
  }

  /** Read everything waiting in socket n's RX ring and RECV it. */
  recv(n: number): number[] {
    const len = this.read16(sock(n), 0x26)
    const rd = this.read16(sock(n), 0x28)
    const data = this.read(rxb(n), rd, len)
    this.write16(sock(n), 0x28, (rd + len) & 0xffff)
    this.cmd(n, 0x40)
    return data
  }
}

describe('W5500Model registers', () => {
  it('identifies as VERSIONR 0x04 and reports link via PHYCFGR', () => {
    const w = new W5500Bus(new W5500Model())
    expect(w.read(COMMON, 0x39, 1)).toEqual([W5500_VERSION])
    expect(w.read(COMMON, 0x2e, 1)[0]! & 1).toBe(1)
    w.h.command('cable', { plugged: false })
    expect(w.read(COMMON, 0x2e, 1)[0]! & 1).toBe(0)
  })

  it('stores the network config with auto-increment and survives chunked frames', () => {
    const w = new W5500Bus(new W5500Model())
    // GAR, SUBR, SHAR, SIPR in one burst, split into 3-byte chunks.
    const config = [10, 0, 2, 2, 255, 255, 255, 0, 0xde, 0xad, 0xbe, 0xef, 0xfe, 0xed, 10, 0, 2, 15]
    w.write(COMMON, 0x01, config, 3)
    expect(w.read(COMMON, 0x01, config.length, 5)).toEqual(config)
    expect(w.h.snapshot()).toMatchObject({ ip: '10.0.2.15', mac: 'de:ad:be:ef:fe:ed' })
  })

  it('MR.RST restores defaults; socket buffer sizes default to 2 KB', () => {
    const w = new W5500Bus(new W5500Model())
    w.write(COMMON, 0x0f, [1, 2, 3, 4])
    w.write(COMMON, 0x00, [0x80])
    expect(w.read(COMMON, 0x0f, 4)).toEqual([0, 0, 0, 0])
    expect(w.read(COMMON, 0x00, 1)).toEqual([0])
    expect(w.read(sock(3), 0x1e, 2)).toEqual([2, 2])
    expect(w.read16(sock(0), 0x20)).toBe(2048)
  })

  it('a register written and read back is what the Arduino Ethernet probe expects', () => {
    const w = new W5500Bus(new W5500Model())
    for (const v of [0x08, 0x10, 0x12, 0x00]) {
      w.write(COMMON, 0x00, [v])
      expect(w.read(COMMON, 0x00, 1)).toEqual([v])
    }
  })
})

describe('W5500Model UDP + DHCP', () => {
  it('answers a DHCP DISCOVER locally with an OFFER for 10.0.2.15', () => {
    const net = new FakeNet()
    const w = new W5500Bus(new W5500Model(), net)
    w.write(sock(0), 0x00, [0x02]) // UDP
    w.write16(sock(0), 0x04, 68)
    w.cmd(0, 0x01)
    expect(w.status(0)).toBe(SR.UDP)
    w.write(sock(0), 0x0c, [255, 255, 255, 255])
    w.write16(sock(0), 0x10, 67)
    const discover = new Array(300).fill(0)
    discover[0] = 1
    discover.splice(4, 4, 0x12, 0x34, 0x56, 0x78)
    discover.splice(236, 7, 0x63, 0x82, 0x53, 0x63, 53, 1, 1)
    discover[243] = 255
    w.send(0, discover)
    expect(w.read(sock(0), 0x02, 1)[0]! & 0x14).toBe(0x14) // SEND_OK | RECV
    expect(net.udpSent).toEqual([])
    const record = w.recv(0)
    expect(record.slice(0, 6)).toEqual([10, 0, 2, 2, 0, 67])
    const payload = Uint8Array.from(record.slice(8))
    expect(dhcpMessageType(payload)).toBe(2) // OFFER
    expect([...payload.subarray(4, 8)]).toEqual([0x12, 0x34, 0x56, 0x78])
    expect([...payload.subarray(16, 20)]).toEqual([10, 0, 2, 15])
  })

  it('sends a datagram through the backend and frames received ones with the 8-byte header', () => {
    const net = new FakeNet()
    const w = new W5500Bus(new W5500Model(), net)
    w.write(sock(1), 0x00, [0x02])
    w.write16(sock(1), 0x04, 5000)
    w.cmd(1, 0x01)
    w.write(sock(1), 0x0c, [10, 0, 2, 3])
    w.write16(sock(1), 0x10, 53)
    w.send(1, [1, 2, 3])
    expect(net.udpSent).toEqual([{ ip: '10.0.2.3', port: 53, data: [1, 2, 3] }])
    net.udpPorts.get(5000)!([10, 0, 2, 3], 53, Uint8Array.of(9, 8))
    expect(w.recv(1)).toEqual([10, 0, 2, 3, 0, 53, 0, 2, 9, 8])
  })
})

describe('W5500Model pointer latching', () => {
  it('Sn_TX_WR takes effect at SEND, so buffered writes at TX_WR + offset add up', () => {
    // The Arduino Ethernet library builds a datagram in pieces: each piece is
    // written at read(Sn_TX_WR) + bytes-so-far, then Sn_TX_WR is written.
    const net = new FakeNet()
    const w = new W5500Bus(new W5500Model(), net)
    w.write(sock(0), 0x00, [0x02])
    w.write16(sock(0), 0x04, 4000)
    w.cmd(0, 0x01)
    w.write(sock(0), 0x0c, [10, 0, 2, 2])
    w.write16(sock(0), 0x10, 9)
    let offset = 0
    for (const piece of [[1, 2, 3], [4, 5], [6]]) {
      const ptr = (w.read16(sock(0), 0x24) + offset) & 0xffff
      w.write(txb(0), ptr, piece)
      w.write16(sock(0), 0x24, ptr + piece.length)
      offset += piece.length
    }
    expect(w.read16(sock(0), 0x24)).toBe(0) // not latched yet
    w.cmd(0, 0x20)
    expect(net.udpSent[0]?.data).toEqual([1, 2, 3, 4, 5, 6])
    expect(w.read16(sock(0), 0x24)).toBe(6)
    expect(w.read16(sock(0), 0x22)).toBe(6)
  })
})

describe('W5500Model TCP', () => {
  it('connects, sends, receives and sees the peer close', () => {
    const net = new FakeNet()
    const w = new W5500Bus(new W5500Model(), net)
    w.write(sock(0), 0x00, [0x01])
    w.write16(sock(0), 0x04, 49152)
    w.cmd(0, 0x01)
    expect(w.status(0)).toBe(SR.INIT)
    w.write(sock(0), 0x0c, [10, 0, 2, 2])
    w.write16(sock(0), 0x10, 8080)
    w.cmd(0, 0x04)
    expect(w.status(0)).toBe(SR.SYNSENT)
    expect(net.tcp[0]).toMatchObject({ ip: '10.0.2.2', port: 8080 })

    net.tcp[0]!.events.onConnect!()
    expect(w.status(0)).toBe(SR.ESTABLISHED)
    expect(w.h.line('INT')).toBe(1) // SIMR is 0: nothing unmasked yet
    w.write(COMMON, 0x18, [0x01]) // SIMR: socket 0
    expect(w.h.line('INT')).toBe(0)
    w.write(sock(0), 0x02, [0x01]) // clear CON
    expect(w.h.line('INT')).toBe(1)

    w.send(0, [...Buffer.from('GET / HTTP/1.0\r\n\r\n')])
    expect(Buffer.from(net.tcp[0]!.written).toString()).toBe('GET / HTTP/1.0\r\n\r\n')
    net.tcp[0]!.events.onData(Uint8Array.from(Buffer.from('HTTP/1.0 200 OK\r\n')))
    expect(Buffer.from(w.recv(0)).toString()).toBe('HTTP/1.0 200 OK\r\n')

    net.tcp[0]!.events.onClose(false)
    expect(w.status(0)).toBe(SR.CLOSE_WAIT)
    w.cmd(0, 0x08)
    expect(w.status(0)).toBe(SR.CLOSED)
  })

  it('DISCON half-closes after queued data instead of destroying the stream', () => {
    const net = new FakeNet()
    const w = new W5500Bus(new W5500Model(), net)
    w.write(sock(0), 0x00, [0x01])
    w.cmd(0, 0x01)
    w.cmd(0, 0x04)
    net.tcp[0]!.events.onConnect!()
    w.send(0, [1, 2, 3])
    w.cmd(0, 0x08)
    expect(net.tcp[0]).toMatchObject({ written: [1, 2, 3], ended: true })
    expect(net.destroyed).toBe(0)
    expect(w.status(0)).toBe(SR.CLOSED)
    // A late peer FIN on the detached stream must not touch the closed socket.
    net.tcp[0]!.events.onClose(false)
    expect(w.status(0)).toBe(SR.CLOSED)
  })

  it('a refused connect times out to CLOSED', () => {
    const net = new FakeNet()
    const w = new W5500Bus(new W5500Model(), net)
    w.write(sock(2), 0x00, [0x01])
    w.cmd(2, 0x01)
    w.cmd(2, 0x04)
    net.tcp[0]!.events.onClose(true)
    expect(w.status(2)).toBe(SR.CLOSED)
    expect(w.read(sock(2), 0x02, 1)[0]! & 0x08).toBe(0x08)
  })

  it('holds back data that overflows the RX ring until the firmware RECVs', () => {
    const net = new FakeNet()
    const w = new W5500Bus(new W5500Model(), net)
    w.write(sock(0), 0x00, [0x01])
    w.cmd(0, 0x01)
    w.cmd(0, 0x04)
    net.tcp[0]!.events.onConnect!()
    const big = new Uint8Array(3000).map((_, i) => i & 0xff)
    net.tcp[0]!.events.onData(big)
    expect(w.read16(sock(0), 0x26)).toBe(2048)
    expect(net.paused).toBe(true)
    const first = w.recv(0)
    const second = w.recv(0)
    expect([...first, ...second]).toEqual([...big])
    expect(net.paused).toBe(false)
  })

  it('a LISTEN socket accepts a host connection on its port', () => {
    const net = new FakeNet()
    const w = new W5500Bus(new W5500Model(), net)
    w.write(sock(0), 0x00, [0x01])
    w.write16(sock(0), 0x04, 80)
    w.cmd(0, 0x01)
    w.cmd(0, 0x02)
    expect(w.status(0)).toBe(SR.LISTEN)
    expect(
      w.h.events.some((e) => e.kind === 'listen' && /host 127\.0\.0\.1:8080/.test(e.summary))
    ).toBe(true)
    const rec = { written: [] as number[], ended: false }
    const events = net.accept!(net.handle(rec), [127, 0, 0, 1], 55555)
    expect(events).not.toBeNull()
    expect(w.status(0)).toBe(SR.ESTABLISHED)
    expect(w.read(sock(0), 0x0c, 4)).toEqual([127, 0, 0, 1])
    events!.onData(Uint8Array.of(0x41))
    expect(w.recv(0)).toEqual([0x41])
    // No socket listening any more: the next connection is refused.
    expect(net.accept!(net.handle(rec), [127, 0, 0, 1], 55556)).toBeNull()
  })
})
