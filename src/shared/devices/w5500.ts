/**
 * WIZnet W5500 — the hardwired-TCP/IP Ethernet controller on the Waveshare
 * ESP32-S3-ETH (SPI: SCK 13, MOSI 11, MISO 12, CS 14; INT 10, RST 9).
 *
 * ## The SPI frame
 *
 * Every access is `addr[15:8] addr[7:0] control data…` inside one CS-low
 * window, with `control = BSB[4:0] << 3 | RWB << 2 | OM[1:0]`. BSB picks the
 * block — 0 the common registers, `4n+1` socket n's registers, `4n+2` its TX
 * buffer, `4n+3` its RX buffer — and the address auto-increments per data
 * byte. Only variable-length mode (OM 00) is modelled; every driver uses it.
 *
 * The host may hand one CS window over in several {@link onBus} chunks (an
 * Arduino `SPI.transfer` per call, the ESP32 SPI FIFO 64 bytes at a time), so
 * the frame is parsed as a stream: a read's MISO byte is produced the moment
 * its address is known, and a write takes effect byte by byte — exactly as
 * the silicon does. CS edges (`onSignal('CS')`) delimit frames; with no CS
 * ever seen (a test calling `onBus` directly) each call is one frame.
 *
 * ## Sockets
 *
 * Eight sockets, each with its own register block and TX/RX ring (2 KB by
 * default, sized by `Sn_TXBUF_SIZE`/`Sn_RXBUF_SIZE`). The firmware drives a
 * socket through `Sn_CR` (OPEN, LISTEN, CONNECT, DISCON, CLOSE, SEND, RECV)
 * and watches `Sn_SR` / `Sn_IR`. TCP and UDP are carried on the host's real
 * network through the {@link NetBackend} the device host lends the model:
 *
 *   - DHCP (UDP to port 67) is answered locally with the {@link GUEST_NET}
 *     lease, so `Ethernet.begin(mac)` gets 10.0.2.15;
 *   - the gateway 10.0.2.2 is the host (`127.0.0.1`) and DNS at 10.0.2.3 is
 *     forwarded to the host's resolver — slirp's layout;
 *   - a LISTEN socket is reachable from the host on the same port (privileged
 *     ports move up by 8000 — the OUT log names the one bound).
 *
 * MACRAW (socket 0 as a raw Ethernet pipe — the ESP-IDF `esp_eth` W5500
 * driver's mode) opens and reports a diagnostic; its frames are not bridged.
 *
 * ## INT
 *
 * Active-low, asserted while any unmasked `IR` bit or any `SIR` bit enabled
 * in `SIMR` is set — the socket interrupt flags are write-1-to-clear.
 */

import type {
  BusResponse,
  BusTransaction,
  DeviceContext,
  DeviceModel,
  DeviceModelDescriptor,
  DeviceSnapshot,
  MeterDeclaration,
  SignalEdge
} from './model'
import { dhcpReply } from './dhcp'
import {
  GUEST_NET,
  ipString,
  type Ipv4,
  type TcpEvents,
  type TcpHandle,
  type TcpListener,
  type UdpHandle
} from './net'

// --- common registers (BSB 0) ----------------------------------------------
const MR = 0x00
const IR = 0x15
const IMR = 0x16
const SIR = 0x17
const SIMR = 0x18
const PHYCFGR = 0x2e
const VERSIONR = 0x39
const COMMON_SIZE = 0x40
export const W5500_VERSION = 0x04

// --- socket registers (BSB 4n+1) -------------------------------------------
const Sn_MR = 0x00
const Sn_CR = 0x01
const Sn_IR = 0x02
const Sn_SR = 0x03
const Sn_PORT = 0x04
const Sn_DIPR = 0x0c
const Sn_DPORT = 0x10
const Sn_RXBUF_SIZE = 0x1e
const Sn_TXBUF_SIZE = 0x1f
const Sn_TX_FSR = 0x20
const Sn_TX_RD = 0x22
const Sn_TX_WR = 0x24
const Sn_RX_RSR = 0x26
const Sn_RX_RD = 0x28
const Sn_RX_WR = 0x2a
const Sn_IMR = 0x2c
const SOCKET_REG_SIZE = 0x30

const MODE_CLOSED = 0
const MODE_TCP = 1
const MODE_UDP = 2
const MODE_MACRAW = 4

const CR_OPEN = 0x01
const CR_LISTEN = 0x02
const CR_CONNECT = 0x04
const CR_DISCON = 0x08
const CR_CLOSE = 0x10
const CR_SEND = 0x20
const CR_SEND_MAC = 0x21
const CR_SEND_KEEP = 0x22
const CR_RECV = 0x40

export const SR = {
  CLOSED: 0x00,
  INIT: 0x13,
  LISTEN: 0x14,
  SYNSENT: 0x15,
  ESTABLISHED: 0x17,
  CLOSE_WAIT: 0x1c,
  UDP: 0x22,
  MACRAW: 0x42
} as const

const SR_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(SR).map(([name, code]) => [code, name])
)

const IR_CON = 0x01
const IR_DISCON = 0x02
const IR_RECV = 0x04
const IR_TIMEOUT = 0x08
const IR_SEND_OK = 0x10

const SOCKETS = 8
const MAX_BUF = 16 * 1024
const DHCP_SERVER_PORT = 67
const UDP_HEADER = 8

interface Socket {
  regs: Uint8Array
  tx: Uint8Array
  rx: Uint8Array
  txRd: number
  txWr: number
  rxRd: number
  rxWr: number
  /**
   * What the firmware last wrote to `Sn_TX_WR` / `Sn_RX_RD`. The part latches
   * them on SEND / RECV; until then a read returns the committed pointer.
   * The Arduino Ethernet library depends on this: it buffers a UDP datagram
   * in several writes, each at `read(Sn_TX_WR) + bytes so far`.
   */
  txWrShadow: number
  rxRdShadow: number
  /** Received bytes that did not fit the RX ring yet (TCP backpressure). */
  pending: Uint8Array[]
  udp: UdpHandle | null
  tcp: TcpHandle | null
  /** Bumped on every OPEN/CLOSE so late callbacks from an old stream are dropped. */
  generation: number
}

interface Frame {
  header: number[]
  addr: number
  bsb: number
  write: boolean
}

export interface W5500Options {
  /** Cable plugged in at power-on. Default true. */
  link?: boolean
}

function be16(regs: Uint8Array, at: number): number {
  return (regs[at]! << 8) | regs[at + 1]!
}

function setBe16(regs: Uint8Array, at: number, value: number): void {
  regs[at] = (value >> 8) & 0xff
  regs[at + 1] = value & 0xff
}

/** Ring size in bytes from a `Sn_*BUF_SIZE` value (0/1/2/4/8/16 KB). */
function ringBytes(kb: number): number {
  return [0, 1, 2, 4, 8, 16].includes(kb) ? kb * 1024 : 2048
}

export class W5500Model implements DeviceModel {
  readonly id = 'wiznet.w5500'
  readonly outputSignals: readonly string[] = ['INT']
  readonly meters: readonly MeterDeclaration[] = [
    { id: 'txBytes', label: 'TX', unit: 'B' },
    { id: 'rxBytes', label: 'RX', unit: 'B' },
    { id: 'sockets', label: 'Open sockets' }
  ]

  private ctx: DeviceContext | null = null
  private common = new Uint8Array(COMMON_SIZE)
  private sockets: Socket[] = []
  private frame: Frame | null = null
  private csFramed = false
  private inReset = false
  private link: boolean
  private intAsserted: boolean | null = null
  private listeners = new Map<number, TcpListener>()
  private txBytes = 0
  private rxBytes = 0
  private macrawWarned = false

  constructor(options: W5500Options = {}) {
    this.link = options.link ?? true
    this.powerOn()
  }

  attach(ctx: DeviceContext): void {
    this.ctx = ctx
    this.updateInt(true)
  }

  reset(): void {
    this.powerOn()
    this.updateInt(true)
  }

  detach(): void {
    this.releaseAll()
    this.ctx = null
  }

  private releaseAll(): void {
    for (const s of this.sockets) this.release(s)
    for (const listener of this.listeners.values()) listener.close()
    this.listeners.clear()
  }

  private powerOn(): void {
    this.releaseAll()
    this.common = new Uint8Array(COMMON_SIZE)
    setBe16(this.common, 0x19, 0x07d0) // RTR 200 ms
    this.common[0x1b] = 0x08 // RCR
    this.common[0x1c] = 0x28 // PTIMER
    this.common[VERSIONR] = W5500_VERSION
    this.sockets = Array.from({ length: SOCKETS }, () => {
      const regs = new Uint8Array(SOCKET_REG_SIZE)
      regs[Sn_RXBUF_SIZE] = 2
      regs[Sn_TXBUF_SIZE] = 2
      regs[Sn_IMR] = 0xff
      regs[0x16] = 0x80 // TTL
      setBe16(regs, 0x12, 0x05b4) // MSSR
      return {
        regs,
        tx: new Uint8Array(MAX_BUF),
        rx: new Uint8Array(MAX_BUF),
        txRd: 0,
        txWr: 0,
        rxRd: 0,
        rxWr: 0,
        txWrShadow: 0,
        rxRdShadow: 0,
        pending: [],
        udp: null,
        tcp: null,
        generation: 0
      }
    })
    this.frame = null
  }

  // --- SPI -----------------------------------------------------------------

  onSignal(edge: SignalEdge): void {
    if (edge.signal === 'CS') {
      this.csFramed = true
      this.frame = edge.level === 0 ? { header: [], addr: 0, bsb: 0, write: false } : null
    } else if (edge.signal === 'RST') {
      if (edge.level === 0) {
        this.inReset = true
      } else if (this.inReset) {
        this.inReset = false
        this.reset()
        this.ctx?.emit({ kind: 'reset', summary: 'Hardware reset (RST released)' })
      }
    }
  }

  onBus(txn: BusTransaction): BusResponse {
    const miso = new Uint8Array(txn.mosi.length)
    if (this.inReset) return { miso }
    if (!this.frame) this.frame = { header: [], addr: 0, bsb: 0, write: false }
    const frame = this.frame
    for (let i = 0; i < txn.mosi.length; i++) {
      const byte = txn.mosi[i]!
      if (frame.header.length < 3) {
        frame.header.push(byte)
        miso[i] = frame.header.length // the part shifts out 0x01, 0x02, 0x03
        if (frame.header.length === 3) {
          frame.addr = (frame.header[0]! << 8) | frame.header[1]!
          frame.bsb = byte >> 3
          frame.write = (byte & 0x04) !== 0
          if ((byte & 0x03) !== 0) {
            this.ctx?.diagnose('warn', 'W5500: fixed-length SPI mode (OM≠00) is not modelled')
          }
        }
        continue
      }
      if (frame.write) {
        this.writeByte(frame.bsb, frame.addr, byte)
      } else {
        miso[i] = this.readByte(frame.bsb, frame.addr)
      }
      frame.addr = (frame.addr + 1) & 0xffff
    }
    if (!this.csFramed) this.frame = null
    return { miso }
  }

  private readByte(bsb: number, addr: number): number {
    if (bsb === 0) {
      if (addr === PHYCFGR) return this.phycfgr()
      if (addr === SIR) return this.sir()
      return addr < COMMON_SIZE ? this.common[addr]! : 0
    }
    const n = bsb >> 2
    const s = this.sockets[n]
    if (!s) return 0
    switch (bsb & 3) {
      case 1:
        return this.readSocketReg(s, addr)
      case 2:
        return s.tx[addr % this.txSize(s)]!
      case 3:
        return s.rx[addr % this.rxSize(s)]!
      default:
        return 0
    }
  }

  private readSocketReg(s: Socket, addr: number): number {
    const word = (value: number, at: number): number =>
      addr === at ? (value >> 8) & 0xff : value & 0xff
    switch (addr) {
      case Sn_TX_FSR:
      case Sn_TX_FSR + 1:
        return word(this.txFree(s), Sn_TX_FSR)
      case Sn_TX_RD:
      case Sn_TX_RD + 1:
        return word(s.txRd, Sn_TX_RD)
      case Sn_TX_WR:
      case Sn_TX_WR + 1:
        return word(s.txWr, Sn_TX_WR)
      case Sn_RX_RSR:
      case Sn_RX_RSR + 1:
        return word(this.rxUsed(s), Sn_RX_RSR)
      case Sn_RX_RD:
      case Sn_RX_RD + 1:
        return word(s.rxRd, Sn_RX_RD)
      case Sn_RX_WR:
      case Sn_RX_WR + 1:
        return word(s.rxWr, Sn_RX_WR)
      default:
        return addr < SOCKET_REG_SIZE ? s.regs[addr]! : 0
    }
  }

  private writeByte(bsb: number, addr: number, value: number): void {
    if (bsb === 0) {
      this.writeCommon(addr, value)
      return
    }
    const n = bsb >> 2
    const s = this.sockets[n]
    if (!s) return
    switch (bsb & 3) {
      case 1:
        this.writeSocketReg(n, s, addr, value)
        break
      case 2:
        s.tx[addr % this.txSize(s)] = value
        break
      case 3:
        s.rx[addr % this.rxSize(s)] = value
        break
    }
  }

  private writeCommon(addr: number, value: number): void {
    if (addr >= COMMON_SIZE || addr === VERSIONR || addr === SIR) return
    if (addr === MR && value & 0x80) {
      this.powerOn()
      this.updateInt()
      this.ctx?.emit({ kind: 'reset', summary: 'Software reset (MR.RST)' })
      return
    }
    if (addr === IR) {
      this.common[IR] = this.common[IR]! & ~value
      this.updateInt()
      return
    }
    this.common[addr] = value
    if (addr === IMR || addr === SIMR) this.updateInt()
  }

  private writeSocketReg(n: number, s: Socket, addr: number, value: number): void {
    if (addr >= SOCKET_REG_SIZE) return
    switch (addr) {
      case Sn_CR:
        this.command(n, s, value)
        return
      case Sn_IR:
        s.regs[Sn_IR] = s.regs[Sn_IR]! & ~value
        this.updateInt()
        return
      case Sn_SR:
      case Sn_TX_FSR:
      case Sn_TX_FSR + 1:
      case Sn_TX_RD:
      case Sn_TX_RD + 1:
      case Sn_RX_RSR:
      case Sn_RX_RSR + 1:
      case Sn_RX_WR:
      case Sn_RX_WR + 1:
        return // read-only
      case Sn_TX_WR:
        s.txWrShadow = ((value << 8) | (s.txWrShadow & 0xff)) & 0xffff
        return
      case Sn_TX_WR + 1:
        s.txWrShadow = ((s.txWrShadow & 0xff00) | value) & 0xffff
        return
      case Sn_RX_RD:
        s.rxRdShadow = ((value << 8) | (s.rxRdShadow & 0xff)) & 0xffff
        return
      case Sn_RX_RD + 1:
        s.rxRdShadow = ((s.rxRdShadow & 0xff00) | value) & 0xffff
        return
      default:
        s.regs[addr] = value
        if (addr === Sn_IMR) this.updateInt()
    }
  }

  // --- socket commands ---------------------------------------------------------

  private command(n: number, s: Socket, cr: number): void {
    const mode = s.regs[Sn_MR]! & 0x0f
    switch (cr) {
      case CR_OPEN:
        this.open(n, s, mode)
        break
      case CR_LISTEN:
        if (s.regs[Sn_SR] === SR.INIT) this.listen(s)
        break
      case CR_CONNECT:
        if (s.regs[Sn_SR] === SR.INIT) this.connect(n, s)
        break
      case CR_DISCON:
        // Graceful: FIN after whatever is still queued for the peer. Detach
        // the stream rather than destroying it, which would drop that data.
        s.tcp?.end()
        s.tcp = null
        this.release(s)
        this.setStatus(s, SR.CLOSED)
        this.raise(s, IR_DISCON)
        break
      case CR_CLOSE:
        this.release(s)
        this.setStatus(s, SR.CLOSED)
        break
      case CR_SEND:
      case CR_SEND_MAC:
        this.send(n, s)
        break
      case CR_SEND_KEEP:
        break
      case CR_RECV:
        s.rxRd = s.rxRdShadow
        this.drainPending(s)
        if (this.rxUsed(s) > 0) this.raise(s, IR_RECV)
        break
      default:
        this.ctx?.diagnose(
          'warn',
          `W5500: socket ${n} command 0x${cr.toString(16)} is not modelled`
        )
    }
  }

  private open(n: number, s: Socket, mode: number): void {
    this.release(s)
    s.txRd = s.txWr = s.rxRd = s.rxWr = s.txWrShadow = s.rxRdShadow = 0
    s.pending = []
    s.regs[Sn_IR] = 0
    const port = be16(s.regs, Sn_PORT)
    if (mode === MODE_TCP) {
      this.setStatus(s, SR.INIT)
    } else if (mode === MODE_UDP) {
      this.setStatus(s, SR.UDP)
      const generation = s.generation
      s.udp =
        this.ctx?.net?.udpOpen(port, (ip, srcPort, data) => {
          if (s.generation === generation) this.deliverUdp(s, ip, srcPort, data)
        }) ?? null
    } else if (mode === MODE_MACRAW && n === 0) {
      this.setStatus(s, SR.MACRAW)
      if (!this.macrawWarned) {
        this.macrawWarned = true
        this.ctx?.diagnose(
          'warn',
          'W5500: MACRAW (raw Ethernet, the esp_eth driver mode) is open but its frames are not bridged — use the hardware socket API (Arduino Ethernet library)'
        )
      }
    } else if (mode !== MODE_CLOSED) {
      this.ctx?.diagnose('warn', `W5500: socket ${n} mode 0x${mode.toString(16)} is not modelled`)
    }
    this.ctx?.emit({ kind: 'socket', summary: `S${n} open ${this.describe(s)} :${port}` })
  }

  private listen(s: Socket): void {
    this.setStatus(s, SR.LISTEN)
    const port = be16(s.regs, Sn_PORT)
    const net = this.ctx?.net
    if (!net || this.listeners.has(port)) return
    const listener = net.tcpListen(
      port,
      (handle, peerIp, peerPort) => this.accept(port, handle, peerIp, peerPort),
      (hostPort) =>
        this.ctx?.emit({
          kind: 'listen',
          summary: `Listening on guest :${port} → host 127.0.0.1:${hostPort}`,
          detail: { guestPort: port, hostPort }
        })
    )
    this.listeners.set(port, listener)
  }

  /** A host connection reached a guest LISTEN port: hand it to a listening socket. */
  private accept(
    port: number,
    handle: TcpHandle,
    peerIp: Ipv4,
    peerPort: number
  ): TcpEvents | null {
    const n = this.sockets.findIndex(
      (s) => s.regs[Sn_SR] === SR.LISTEN && be16(s.regs, Sn_PORT) === port
    )
    const s = this.sockets[n]
    if (!s) return null
    s.tcp = handle
    s.regs.set(peerIp.slice(0, 4), Sn_DIPR)
    setBe16(s.regs, Sn_DPORT, peerPort)
    this.setStatus(s, SR.ESTABLISHED)
    this.raise(s, IR_CON)
    this.ctx?.emit({ kind: 'tcp', summary: `S${n} accepted ${ipString(peerIp)}:${peerPort}` })
    return this.streamEvents(n, s)
  }

  private connect(n: number, s: Socket): void {
    const ip = Array.from(s.regs.subarray(Sn_DIPR, Sn_DIPR + 4))
    const port = be16(s.regs, Sn_DPORT)
    this.setStatus(s, SR.SYNSENT)
    const net = this.ctx?.net
    if (!net) {
      this.setStatus(s, SR.CLOSED)
      this.raise(s, IR_TIMEOUT)
      return
    }
    const events = this.streamEvents(n, s)
    s.tcp = net.tcpConnect(ip, port, events)
    this.ctx?.emit({ kind: 'tcp', summary: `S${n} connecting to ${ipString(ip)}:${port}` })
  }

  /** Event sink shared by outbound and accepted TCP streams. */
  private streamEvents(n: number, s: Socket): TcpEvents {
    const generation = s.generation
    const live = (): boolean => s.generation === generation
    return {
      onConnect: () => {
        if (!live()) return
        this.setStatus(s, SR.ESTABLISHED)
        this.raise(s, IR_CON)
        this.ctx?.emit({ kind: 'tcp', summary: `S${n} connected` })
      },
      onData: (data) => {
        if (live()) this.deliverTcp(s, data)
      },
      onClose: (hadError) => {
        if (!live()) return
        s.tcp = null
        if (s.regs[Sn_SR] === SR.SYNSENT) {
          this.setStatus(s, SR.CLOSED)
          this.raise(s, IR_TIMEOUT)
          this.ctx?.emit({ kind: 'tcp', summary: `S${n} connect failed` })
        } else {
          this.setStatus(s, SR.CLOSE_WAIT)
          this.raise(s, IR_DISCON)
          this.ctx?.emit({ kind: 'tcp', summary: `S${n} peer closed${hadError ? ' (error)' : ''}` })
        }
      }
    }
  }

  private send(n: number, s: Socket): void {
    s.txWr = s.txWrShadow
    const size = this.txSize(s)
    const length = (s.txWr - s.txRd) & 0xffff
    const data = new Uint8Array(Math.min(length, size))
    for (let i = 0; i < data.length; i++) data[i] = s.tx[(s.txRd + i) % size]!
    s.txRd = s.txWr
    this.txBytes += data.length
    const status = s.regs[Sn_SR]
    if (status === SR.ESTABLISHED || status === SR.CLOSE_WAIT) {
      s.tcp?.write(data)
    } else if (status === SR.UDP) {
      const ip = Array.from(s.regs.subarray(Sn_DIPR, Sn_DIPR + 4))
      const port = be16(s.regs, Sn_DPORT)
      this.ctx?.emit({ kind: 'udp', summary: `S${n} → ${ipString(ip)}:${port} (${data.length} B)` })
      if (port === DHCP_SERVER_PORT) {
        const reply = dhcpReply(data)
        if (reply) {
          // The firmware polls for the answer right after SEND_OK.
          this.deliverUdp(s, GUEST_NET.gateway, DHCP_SERVER_PORT, reply)
          this.ctx?.emit({
            kind: 'dhcp',
            summary: `DHCP lease ${ipString(GUEST_NET.guest)} (gw ${ipString(GUEST_NET.gateway)}, dns ${ipString(GUEST_NET.dns)})`
          })
        }
      } else {
        s.udp?.send(ip, port, data)
      }
    } else if (status !== SR.MACRAW) {
      this.ctx?.diagnose('warn', `W5500: SEND on socket ${n} in state ${this.statusName(s)}`)
    }
    this.raise(s, IR_SEND_OK)
  }

  // --- receive path ------------------------------------------------------------

  private deliverUdp(s: Socket, ip: Ipv4, port: number, data: Uint8Array): void {
    const record = new Uint8Array(UDP_HEADER + data.length)
    record.set(ip.slice(0, 4), 0)
    record[4] = (port >> 8) & 0xff
    record[5] = port & 0xff
    record[6] = (data.length >> 8) & 0xff
    record[7] = data.length & 0xff
    record.set(data, UDP_HEADER)
    // A datagram that does not fit is dropped whole, as on the part.
    if (record.length > this.rxSize(s) - this.rxUsed(s)) return
    this.writeRx(s, record)
    this.raise(s, IR_RECV)
  }

  private deliverTcp(s: Socket, data: Uint8Array): void {
    s.pending.push(data)
    this.drainPending(s)
    if (this.rxUsed(s) > 0) this.raise(s, IR_RECV)
  }

  /** Move queued TCP bytes into whatever RX space the firmware has freed. */
  private drainPending(s: Socket): void {
    while (s.pending.length > 0) {
      const free = this.rxSize(s) - this.rxUsed(s)
      if (free <= 0) break
      const head = s.pending[0]!
      const chunk = head.subarray(0, free)
      this.writeRx(s, chunk)
      if (chunk.length === head.length) s.pending.shift()
      else s.pending[0] = head.subarray(chunk.length)
    }
    if (s.pending.length > 0) s.tcp?.pause()
    else s.tcp?.resume()
  }

  private writeRx(s: Socket, bytes: Uint8Array): void {
    const size = this.rxSize(s)
    for (let i = 0; i < bytes.length; i++) s.rx[(s.rxWr + i) % size] = bytes[i]!
    s.rxWr = (s.rxWr + bytes.length) & 0xffff
    this.rxBytes += bytes.length
  }

  // --- helpers -----------------------------------------------------------------

  private txSize(s: Socket): number {
    return ringBytes(s.regs[Sn_TXBUF_SIZE]!)
  }

  private rxSize(s: Socket): number {
    return ringBytes(s.regs[Sn_RXBUF_SIZE]!)
  }

  private txFree(s: Socket): number {
    return this.txSize(s) - ((s.txWr - s.txRd) & 0xffff)
  }

  private rxUsed(s: Socket): number {
    return (s.rxWr - s.rxRd) & 0xffff
  }

  private release(s: Socket): void {
    s.generation++
    s.udp?.close()
    s.udp = null
    s.tcp?.destroy()
    s.tcp = null
    s.pending = []
  }

  private setStatus(s: Socket, status: number): void {
    s.regs[Sn_SR] = status
  }

  private raise(s: Socket, bits: number): void {
    s.regs[Sn_IR] = s.regs[Sn_IR]! | bits
    this.updateInt()
  }

  private sir(): number {
    let bits = 0
    this.sockets.forEach((s, n) => {
      if (s.regs[Sn_IR]! & s.regs[Sn_IMR]!) bits |= 1 << n
    })
    return bits
  }

  private phycfgr(): number {
    // RST=1, OPMD=0, OPMDC=111 (all capable, auto-negotiate); 100 Mb full duplex.
    return 0xb8 | (this.link ? 0x07 : 0x00)
  }

  private updateInt(force = false): void {
    const asserted =
      (this.sir() & this.common[SIMR]!) !== 0 || (this.common[IR]! & this.common[IMR]!) !== 0
    if (!force && asserted === this.intAsserted) return
    this.intAsserted = asserted
    this.ctx?.driveSignal('INT', asserted ? 0 : 1)
  }

  onCommand(command: string, args?: Record<string, unknown>): void {
    if (command === 'cable' || (command === 'setParam' && args?.['link'] !== undefined)) {
      const plugged = Boolean(args?.['plugged'] ?? args?.['link'])
      if (plugged === this.link) return
      this.link = plugged
      this.ctx?.emit({ kind: 'link', summary: plugged ? 'Cable plugged in' : 'Cable unplugged' })
    } else {
      this.ctx?.diagnose('warn', `W5500: unrecognized command "${command}"`)
    }
  }

  private statusName(s: Socket): string {
    return SR_NAMES[s.regs[Sn_SR]!] ?? `0x${s.regs[Sn_SR]!.toString(16)}`
  }

  private describe(s: Socket): string {
    const mode = s.regs[Sn_MR]! & 0x0f
    return mode === MODE_TCP
      ? 'TCP'
      : mode === MODE_UDP
        ? 'UDP'
        : mode === MODE_MACRAW
          ? 'MACRAW'
          : `mode ${mode}`
  }

  snapshot(): DeviceSnapshot {
    const mac = Array.from(this.common.subarray(0x09, 0x0f), (b) =>
      b.toString(16).padStart(2, '0')
    ).join(':')
    return {
      link: this.link,
      mac,
      ip: ipString(Array.from(this.common.subarray(0x0f, 0x13))),
      gateway: ipString(Array.from(this.common.subarray(0x01, 0x05))),
      subnet: ipString(Array.from(this.common.subarray(0x05, 0x09))),
      intAsserted: this.intAsserted === true,
      sockets: this.sockets
        .map((s, n) => ({
          n,
          status: this.statusName(s),
          mode: this.describe(s),
          port: be16(s.regs, Sn_PORT),
          peer: `${ipString(Array.from(s.regs.subarray(Sn_DIPR, Sn_DIPR + 4)))}:${be16(s.regs, Sn_DPORT)}`
        }))
        .filter((row) => row.status !== 'CLOSED')
    }
  }

  meter(id: string): number | undefined {
    if (id === 'txBytes') return this.txBytes
    if (id === 'rxBytes') return this.rxBytes
    if (id === 'sockets') return this.sockets.filter((s) => s.regs[Sn_SR] !== SR.CLOSED).length
    return undefined
  }
}

export const w5500Descriptor: DeviceModelDescriptor = {
  id: 'wiznet.w5500',
  summary:
    'WIZnet W5500 hardwired TCP/IP Ethernet over SPI: common + 8 socket register blocks, TX/RX rings, INT; TCP/UDP sockets bridged to the host network, DHCP answered locally.',
  create: (options) => new W5500Model({ link: options?.['link'] !== false })
}
