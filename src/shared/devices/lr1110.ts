/**
 * Semtech LR1110 — the M9's sub-GHz LoRa transceiver, and the device the whole
 * product exists for (roadmap M7). It sits on the shared `spi0` bus behind
 * `LR_NSS` (GPIO39), with `BUSY` (41), `IRQ`/DIO9 (42) and `NRESET` (45) as
 * discrete lines.
 *
 * ## Shape of the traffic
 *
 * MeshCore drives the part through RadioLib's `LR11x0` module. Every command is
 * a 16-bit big-endian opcode, MSB first, clocked in one `NSS`-low..`NSS`-high
 * group — which is exactly one {@link onBus} transaction (the host routes by
 * the asserted select, `NSS`). RadioLib's framing, confirmed against
 * `RadioLib/src/Module.cpp` and `modules/LR11x0/`:
 *
 *   - **Write command**: `mosi = [opHi, opLo, ...params]`. The reply is
 *     ignored on the wire; RadioLib verifies it with a *separate* status read.
 *   - **Read command**: two transactions. First a write of `[opHi, opLo,
 *     ...args]`; then a second transaction of all-`0x00` (a bare NOP, command
 *     width set to 0) whose reply is `[Stat1, ...data]` — the status byte
 *     first, then `len` data bytes.
 *   - **Status poll** (`SPIcheckStatus`) and **IRQ poll** (`getIrqStatus`):
 *     a bare read of six `0x00` bytes, reply `[Stat1, Stat2, irq31..irq0]`.
 *
 * `SPIparseStatus` reads `Stat1` on every command: bits 3:1 must be `CMD_OK`
 * (`0b010`), and the byte must be neither `0x00` nor `0xFF`, or RadioLib
 * returns `RADIOLIB_ERR_CHIP_NOT_FOUND` / `_SPI_CMD_FAILED` long before any
 * timeout. `GetVersion`'s device byte must read back `0x01` (LR1110) for
 * `findChip()` to succeed.
 *
 * ADR 0001's rule holds: `onBus` takes and returns a whole buffer. Fidelity is
 * functional (a v1 non-goal is cycle accuracy): the command set is what
 * MeshCore/RadioLib actually issues on the LoRa path, `BUSY` is modelled as
 * "always ready" (held low — the host drives the guest-visible line in M7.2),
 * and every opcode outside the known set raises a loud named diagnostic rather
 * than returning silent zeros (M7's rule).
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  sign as edSign
} from 'node:crypto'

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

// --- LR11x0 command opcodes (RadioLib LR11x0_commands.h) --------------------

const OP = {
  NOP: 0x0000,
  WRITE_REG_MEM: 0x0105,
  READ_REG_MEM: 0x0106,
  WRITE_BUFFER: 0x0109,
  READ_BUFFER: 0x010a,
  CLEAR_RX_BUFFER: 0x010b,
  GET_STATUS: 0x0100,
  GET_VERSION: 0x0101,
  GET_ERRORS: 0x010d,
  CLEAR_ERRORS: 0x010e,
  CALIBRATE: 0x010f,
  SET_REG_MODE: 0x0110,
  CALIB_IMAGE: 0x0111,
  SET_DIO_AS_RF_SWITCH: 0x0112,
  SET_DIO_IRQ_PARAMS: 0x0113,
  CLEAR_IRQ: 0x0114,
  CONFIG_LF_CLOCK: 0x0116,
  SET_TCXO_MODE: 0x0117,
  GET_VBAT: 0x0119,
  GET_TEMP: 0x011a,
  SET_SLEEP: 0x011b,
  SET_STANDBY: 0x011c,
  SET_FS: 0x011d,
  GET_RANDOM_NUMBER: 0x0120,
  DRIVE_DIOS_IN_SLEEP_MODE: 0x012a,
  RESET_STATS: 0x0200,
  GET_STATS: 0x0201,
  GET_PACKET_TYPE: 0x0202,
  GET_RX_BUFFER_STATUS: 0x0203,
  GET_PACKET_STATUS: 0x0204,
  GET_RSSI_INST: 0x0205,
  SET_GFSK_SYNC_WORD: 0x0206,
  SET_LORA_PUBLIC_NETWORK: 0x0208,
  SET_RX: 0x0209,
  SET_TX: 0x020a,
  SET_RF_FREQUENCY: 0x020b,
  AUTO_TX_RX: 0x020c,
  SET_CAD_PARAMS: 0x020d,
  SET_PACKET_TYPE: 0x020e,
  SET_MODULATION_PARAMS: 0x020f,
  SET_PACKET_PARAMS: 0x0210,
  SET_TX_PARAMS: 0x0211,
  SET_PACKET_ADRS: 0x0212,
  SET_RX_TX_FALLBACK_MODE: 0x0213,
  SET_RX_DUTY_CYCLE: 0x0214,
  SET_PA_CONFIG: 0x0215,
  STOP_TIMEOUT_ON_PREAMBLE: 0x0217,
  SET_CAD: 0x0218,
  SET_LORA_SYNCH_TIMEOUT: 0x021b,
  SET_RX_BOOSTED: 0x0227,
  SET_RSSI_CALIBRATION: 0x0229,
  SET_LORA_SYNC_WORD: 0x022b,
  GET_LORA_RX_HEADER_INFOS: 0x0230,
  WIFI_READ_VERSION: 0x0320,
  GNSS_READ_VERSION: 0x0406
} as const

/** Opcodes RadioLib reads a reply from (via the two-transaction read path). */
const READ_OPS = new Set<number>([
  OP.READ_REG_MEM,
  OP.READ_BUFFER,
  OP.GET_STATUS,
  OP.GET_VERSION,
  OP.GET_ERRORS,
  OP.GET_VBAT,
  OP.GET_TEMP,
  OP.GET_RANDOM_NUMBER,
  OP.GET_STATS,
  OP.GET_PACKET_TYPE,
  OP.GET_RX_BUFFER_STATUS,
  OP.GET_PACKET_STATUS,
  OP.GET_RSSI_INST,
  OP.GET_LORA_RX_HEADER_INFOS,
  OP.WIFI_READ_VERSION,
  OP.GNSS_READ_VERSION
])

/** Every opcode we recognise — anything else is a loud diagnostic. */
const KNOWN_OPS = new Set<number>(Object.values(OP))

// Stat1 (RadioLib LR11x0_commands.h): bits 3:1 command status, bit 0 IRQ.
const STAT1_CMD_OK = 0x02 << 1 // 0b010 in bits 3:1
const STAT1_IRQ_ACTIVE = 0x01

// Stat2: bits 7:4 reset status, bits 3:1 chip mode, bit 0 exec source.
const STAT2_RST_ANALOG = 0x01 << 4
const STAT2_FLASH = 0x01
const STAT2_MODE = {
  sleep: 0x00 << 1,
  standby: 0x01 << 1, // STBY_RC
  fs: 0x03 << 1,
  rx: 0x04 << 1,
  tx: 0x05 << 1
} as const

const PACKET_TYPE_LORA = 0x02

// IRQ bits (32-bit IRQ word).
const IRQ_TX_DONE = 0x01 << 2
const IRQ_RX_DONE = 0x01 << 3

// LoRa bandwidth register value → kHz (RadioLib LR11X0_LORA_BW_*).
const BW_KHZ: Record<number, number> = { 0x03: 62.5, 0x04: 125, 0x05: 250, 0x06: 500 }

type RadioMode = 'sleep' | 'standby' | 'fs' | 'rx' | 'tx'

export interface Lr1110Options {
  /** Hardware device byte `GetVersion` reports. `0x01` = LR1110 (default). */
  deviceId?: number
  /**
   * ms to wait after an NRESET pulse for the first SPI command before raising
   * the "bus never begun" diagnostic. Default 2000; override in tests.
   */
  noTrafficMs?: number
}

function lr1110Options(raw?: Record<string, unknown>): Lr1110Options {
  const o: Lr1110Options = {}
  if (typeof raw?.['deviceId'] === 'number') o.deviceId = raw['deviceId'] & 0xff
  if (typeof raw?.['noTrafficMs'] === 'number') o.noTrafficMs = raw['noTrafficMs']
  return o
}

/**
 * LoRa time-on-air in ms (Semtech AN1200.13 / SX126x datasheet §6.1.4). `crDen`
 * is the 4/x denominator (5..8); `payloadLen` is the PHY payload in bytes.
 */
export function loraToaMs(sf: number, bwHz: number, crDen: number, payloadLen: number): number {
  if (sf < 5 || bwHz <= 0) return 0
  const tSym = (Math.pow(2, sf) / bwHz) * 1000
  const de = tSym > 16 ? 1 : 0
  const ih = 0 // explicit header
  const crn = crDen - 4 // 1..4
  const num = 8 * payloadLen - 4 * sf + 28 + 16 - 20 * ih
  const den = 4 * (sf - 2 * de)
  const nPayload = 8 + Math.max(Math.ceil(num / den) * (crn + 4), 0)
  const tPreamble = (8 + 4.25) * tSym
  return Math.round((tPreamble + nPayload * tSym) * 100) / 100
}

export class Lr1110Model implements DeviceModel {
  readonly id = 'semtech.lr1110'
  /** BUSY (GPIO41) and DIO9/IRQ (GPIO42) are inputs the SoC level-polls. */
  readonly outputSignals = ['BUSY', 'IRQ'] as const
  readonly meters: readonly MeterDeclaration[] = [
    { id: 'freq', label: 'Frequency', unit: 'Hz' },
    { id: 'rssi', label: 'Last RSSI', unit: 'dBm' },
    { id: 'airtime', label: 'Airtime', unit: 'ms' },
    { id: 'busShare', label: 'Bus share', unit: '%' }
  ]

  private ctx: DeviceContext | null = null
  private readonly deviceId: number
  private readonly noTrafficMs: number

  // Diagnostic: firmware pulsed NRESET (radio bring-up started) but then no SPI
  // command followed. The usual cause is a variant `radio_init()` that builds
  // `Module(..., SPI)` on a caller-owned SPIClass and never `SPI.begin()`s it —
  // RadioLib only starts the bus when it owns the instance, so every transfer is
  // a silent no-op and `radio.begin()` returns -707 with the boot splash frozen.
  // Name it instead of leaving a blank screen. (Only catches firmware that
  // pulses NRESET, which RadioLib's `begin()` always does.)
  private noTrafficTimer: ReturnType<typeof setTimeout> | null = null
  private noTrafficWarned = false

  // Line state.
  private nssLow = false
  private resetAsserted = false

  // SPI frame reassembly. RadioLib's ArduinoHal clocks each LR11x0 command one
  // byte per SPI transaction, so `onBus` is called once per byte. A frame is the
  // run of bytes between an NSS falling and rising edge; we accumulate MOSI,
  // recompute the whole reply each byte, and hand back this byte's slice. The
  // 16-bit opcode is `frameMosi[0..1]`. See {@link Sx1262Model} for the sibling.
  private frameMosi: number[] = []
  private frameReplied = 0
  private frameActive = false
  private lastBusT = 0
  private warnedNoFrame = false

  // Controller state.
  private mode: RadioMode = 'standby'
  private packetType = PACKET_TYPE_LORA
  private freqHz = 0
  private sf = 0
  private bwHz = 0
  private crDen = 5
  private txPowerDbm = 0
  private irq = 0
  private irqMask = 0xffffffff
  private lastRssi = -110
  private lastSnr = 0
  private lastAirtimeMs = 0
  private resetCount = 0

  // Buffers.
  private txBuffer = new Uint8Array(0)
  private rxBuffer = new Uint8Array(0)
  private rxLen = 0
  private noiseFloorDbm = -120
  private rxCount = 0
  private txCount = 0

  /** A read whose reply the next bare-NOP transaction will carry. */
  private pendingRead: Uint8Array | null = null

  private bytesOnBus = 0

  constructor(options: Lr1110Options = {}) {
    this.deviceId = options.deviceId ?? 0x01
    this.noTrafficMs = options.noTrafficMs ?? 2000
  }

  attach(ctx: DeviceContext): void {
    this.ctx = ctx
    this.powerOn()
  }

  reset(): void {
    this.powerOn()
    // A host-driven board reload starts a fresh session — let the watchdog fire
    // again (a firmware retry loop, which only re-pulses NRESET, does not).
    this.noTrafficWarned = false
    this.ctx?.emit({ kind: 'reset', summary: 'Radio reset' })
  }

  detach(): void {
    this.clearNoTrafficCheck()
    this.ctx = null
  }

  /** Arm the "NRESET pulsed, no SPI command" watchdog. Fires at most once. */
  private armNoTrafficCheck(): void {
    if (this.noTrafficWarned) return
    this.clearNoTrafficCheck()
    const bytesAtArm = this.bytesOnBus
    this.noTrafficTimer = setTimeout(() => {
      this.noTrafficTimer = null
      if (this.noTrafficWarned || this.bytesOnBus > bytesAtArm) return
      this.noTrafficWarned = true
      this.ctx?.diagnose(
        'error',
        `LR1110: NRESET pulsed but no SPI command in ${this.noTrafficMs} ms — ` +
          'the LoRa SPI bus was never begun. RadioLib does not start a ' +
          "caller-owned SPIClass, so the variant's radio_init() must call " +
          'spi.begin(SCLK, MISO, MOSI, NSS) before radio.begin(); without it ' +
          'every transfer is a no-op and radio.begin() fails -707.'
      )
    }, this.noTrafficMs)
    ;(this.noTrafficTimer as { unref?: () => void }).unref?.()
  }

  private clearNoTrafficCheck(): void {
    if (this.noTrafficTimer) {
      clearTimeout(this.noTrafficTimer)
      this.noTrafficTimer = null
    }
  }

  private powerOn(): void {
    this.clearNoTrafficCheck()
    this.nssLow = false
    this.resetAsserted = false
    this.frameMosi = []
    this.frameReplied = 0
    this.frameActive = false
    this.warnedNoFrame = false
    this.mode = 'standby'
    this.packetType = PACKET_TYPE_LORA
    this.freqHz = 0
    this.sf = 0
    this.bwHz = 0
    this.crDen = 5
    this.txPowerDbm = 0
    this.irq = 0
    this.irqMask = 0xffffffff
    this.lastRssi = -110
    this.lastSnr = 0
    this.lastAirtimeMs = 0
    this.txBuffer = new Uint8Array(0)
    this.rxBuffer = new Uint8Array(0)
    this.rxLen = 0
    this.noiseFloorDbm = -120
    this.pendingRead = null
    this.ctx?.driveSignal('BUSY', 0)
    this.ctx?.driveSignal('IRQ', 0)
  }

  // --- lines in ----------------------------------------------------------

  onSignal(edge: SignalEdge): void {
    switch (edge.signal) {
      case 'NSS':
      case 'CS': {
        const low = edge.level === 0
        this.nssLow = low
        if (low) {
          // Start of an SPI frame.
          this.frameMosi = []
          this.frameReplied = 0
          this.frameActive = true
        } else if (this.frameActive) {
          // End of frame — a write command takes effect now, a read arms the
          // reply the next (all-zero) frame will carry.
          this.frameActive = false
          this.commitFrame()
        }
        return
      }
      case 'NRESET':
      case 'RESET':
      case 'RST': {
        // NRESET is active-low: level 0 asserts reset, the rising edge releases.
        const asserted = edge.level === 0
        if (asserted && !this.resetAsserted) {
          this.resetAsserted = true
        } else if (!asserted && this.resetAsserted) {
          this.resetAsserted = false
          this.resetCount += 1
          this.powerOn()
          this.ctx?.emit({ kind: 'reset', summary: 'Hardware reset (NRESET)' })
          this.armNoTrafficCheck()
        }
        return
      }
      // BUSY and IRQ/DIO9 are lines the *device* drives; nothing should drive
      // them into us. Flag it rather than silently absorb a wiring mistake.
      default:
        this.ctx?.diagnose('warn', `LR1110 has no input line "${edge.signal}"`)
    }
  }

  // --- bus in ----------------------------------------------------------

  onBus(txn: BusTransaction): BusResponse {
    const mosi = txn.mosi
    this.bytesOnBus += mosi.length
    this.lastBusT = txn.t
    // Real SPI traffic arrived — the bus is up; stand the watchdog down.
    this.clearNoTrafficCheck()
    if (mosi.length === 0) return { miso: new Uint8Array(0) }

    // Byte-at-a-time delivery inside an NSS frame (the live RadioLib path):
    // accumulate MOSI, recompute the whole frame reply, hand back this slice.
    if (this.frameActive) {
      for (const b of mosi) this.frameMosi.push(b)
      const full = this.renderFrame(this.frameMosi)
      const out = new Uint8Array(mosi.length)
      for (let i = 0; i < mosi.length; i++) out[i] = full[this.frameReplied + i] ?? this.stat1()
      this.frameReplied += mosi.length
      return { miso: out }
    }

    // No NSS framing around this call — a whole-command delivery (a test via
    // `injectBus`, or a bridge that coalesces per chip-select). The buffer is a
    // complete, self-contained frame. A *byte-sized* call here means the live
    // per-byte path lost its NSS edges (a chip-select the host doesn't route, or
    // a board file that doesn't name the LR1110's select `NSS`) — that silently
    // returns zeros, which RadioLib reads as `-707`, so flag it once (M7's rule).
    if (!this.warnedNoFrame && mosi.length < 2) {
      this.warnedNoFrame = true
      this.ctx?.diagnose('warn', 'LR1110: SPI byte with no NSS frame — chip-select not wired?')
    }
    return this.onBusWhole(mosi, txn.t)
  }

  /**
   * The complete MISO for the NSS frame accumulated so far. LR11x0 read data
   * arrives in the *following* all-zero frame (two-transaction read), so within
   * a command frame the reply is just the status byte; the all-zero read-back
   * and the bare status/IRQ poll are the shapes that carry real bytes.
   */
  private renderFrame(frame: number[]): Uint8Array {
    const miso = new Uint8Array(frame.length)
    miso.fill(this.stat1())

    // The all-zero read-back that follows a read command.
    if (this.pendingRead && isAllZeroArray(frame)) {
      const data = this.pendingRead
      for (let i = 0; i < data.length && i + 1 < miso.length; i++) miso[i + 1] = data[i]!
      return miso
    }

    // A bare NOP frame with no pending read: SPIcheckStatus (miso[0]) or
    // getIrqStatus (miso[2..5]). One shape serves both. `renderFrame` is
    // recomputed as the frame grows a byte at a time, so every position must be
    // written independently of the final length — a `miso.length > 5` gate
    // would leave positions 2..4 holding the status fill they were replied with
    // before the frame reached six bytes.
    if (frame.length >= 2 && frame[0] === 0 && frame[1] === 0) {
      if (miso.length > 1) miso[1] = this.stat2()
      const irq = this.irq >>> 0
      const irqBytes = [(irq >>> 24) & 0xff, (irq >>> 16) & 0xff, (irq >>> 8) & 0xff, irq & 0xff]
      for (let i = 0; i < 4 && 2 + i < miso.length; i++) miso[2 + i] = irqBytes[i]!
      return miso
    }

    return miso
  }

  /** Apply a completed NSS frame's side effects (called on the NSS rising edge). */
  private commitFrame(): void {
    const frame = this.frameMosi
    if (this.pendingRead && isAllZeroArray(frame)) {
      // That frame was the read-back of the previous read command.
      this.pendingRead = null
      return
    }
    if (frame.length < 2) return
    const op = (frame[0]! << 8) | frame[1]!
    if (op === OP.NOP) return
    const params = Uint8Array.from(frame.slice(2))
    if (!KNOWN_OPS.has(op)) {
      this.ctx?.diagnose(
        'warn',
        `LR1110: unimplemented command 0x${op.toString(16).padStart(4, '0')}`
      )
      return
    }
    if (READ_OPS.has(op)) {
      this.pendingRead = this.buildReadReply(op, params)
      return
    }
    this.applyWrite(op, params, this.lastBusT)
  }

  private onBusWhole(mosi: Uint8Array, t: number): BusResponse {
    const miso = new Uint8Array(mosi.length)

    // A read reply pending from the previous transaction — this NOP fetches it.
    if (this.pendingRead && isAllZero(mosi)) {
      miso[0] = this.stat1()
      const data = this.pendingRead
      for (let i = 0; i < data.length && i + 1 < miso.length; i++) miso[i + 1] = data[i]!
      this.pendingRead = null
      return { miso }
    }

    if (mosi.length < 2) return { miso }
    const op = (mosi[0]! << 8) | mosi[1]!

    // A bare read of NOPs with no pending reply: SPIcheckStatus (reads miso[0])
    // or getIrqStatus (reads miso[2..5]). One shape serves both.
    if (op === OP.NOP) {
      miso[0] = this.stat1()
      if (miso.length > 1) miso[1] = this.stat2()
      const irq = this.irq >>> 0
      if (miso.length > 5) {
        miso[2] = (irq >>> 24) & 0xff
        miso[3] = (irq >>> 16) & 0xff
        miso[4] = (irq >>> 8) & 0xff
        miso[5] = irq & 0xff
      }
      return { miso }
    }

    const params = mosi.subarray(2)

    if (!KNOWN_OPS.has(op)) {
      this.ctx?.diagnose(
        'warn',
        `LR1110: unimplemented command 0x${op.toString(16).padStart(4, '0')}`
      )
      return { miso }
    }

    if (READ_OPS.has(op)) {
      this.pendingRead = this.buildReadReply(op, params)
      return { miso }
    }

    this.applyWrite(op, params, t)
    return { miso }
  }

  private buildReadReply(op: number, args: Uint8Array): Uint8Array {
    switch (op) {
      case OP.GET_VERSION:
        // [hw, device, fwMajor, fwMinor] — device must be 0x01 for findChip().
        return new Uint8Array([0x22, this.deviceId, 0x04, 0x01])
      case OP.GET_ERRORS:
        return new Uint8Array([0x00, 0x00])
      case OP.GET_STATUS:
        return new Uint8Array([this.stat1(), this.stat2()])
      case OP.GET_PACKET_TYPE:
        return new Uint8Array([this.packetType])
      case OP.GET_RX_BUFFER_STATUS:
        return new Uint8Array([this.rxLen & 0xff, 0x00])
      case OP.GET_PACKET_STATUS: {
        // LoRa: [rssiPkt, snrPkt, signalRssiPkt]; RadioLib decodes
        // rssi = -raw/2, snr = raw(int8)/4.
        const rssiRaw = Math.min(255, Math.max(0, Math.round(-2 * this.lastRssi)))
        const snrRaw = Math.max(-128, Math.min(127, Math.round(4 * this.lastSnr))) & 0xff
        return new Uint8Array([rssiRaw, snrRaw, rssiRaw])
      }
      case OP.GET_RSSI_INST:
        return new Uint8Array([Math.min(255, Math.max(0, Math.round(-2 * this.lastRssi)))])
      case OP.GET_RANDOM_NUMBER:
        return new Uint8Array([
          Math.floor(Math.random() * 256),
          Math.floor(Math.random() * 256),
          Math.floor(Math.random() * 256),
          Math.floor(Math.random() * 256)
        ])
      case OP.WIFI_READ_VERSION:
      case OP.GNSS_READ_VERSION:
        return new Uint8Array([0x01, 0x00])
      case OP.READ_BUFFER: {
        // args = [offset, len]
        const offset = args[0] ?? 0
        const len = args[1] ?? this.rxLen
        return this.rxBuffer.slice(offset, offset + len)
      }
      case OP.READ_REG_MEM: {
        // args = [addr32, len]; we do not model registers — zeros.
        const len = args[4] ?? 0
        return new Uint8Array(len)
      }
      default:
        return new Uint8Array(0)
    }
  }

  private applyWrite(op: number, params: Uint8Array, t: number): void {
    switch (op) {
      case OP.SET_SLEEP:
        this.mode = 'sleep'
        this.ctx?.emit({ kind: 'mode', summary: 'Sleep' })
        break
      case OP.SET_STANDBY:
        this.mode = 'standby'
        this.ctx?.emit({ kind: 'mode', summary: 'Standby' })
        break
      case OP.SET_FS:
        this.mode = 'fs'
        break
      case OP.SET_PACKET_TYPE:
        this.packetType = params[0] ?? PACKET_TYPE_LORA
        this.ctx?.emit({
          kind: 'cmd',
          summary: `Packet type ${this.packetType === PACKET_TYPE_LORA ? 'LoRa' : `0x${this.packetType.toString(16)}`}`
        })
        break
      case OP.SET_RF_FREQUENCY:
        this.freqHz =
          ((params[0]! << 24) | (params[1]! << 16) | (params[2]! << 8) | params[3]!) >>> 0
        this.ctx?.emit({ kind: 'cmd', summary: `Frequency ${(this.freqHz / 1e6).toFixed(3)} MHz` })
        break
      case OP.SET_MODULATION_PARAMS:
        if (this.packetType === PACKET_TYPE_LORA && params.length >= 3) {
          this.sf = params[0]!
          this.bwHz = (BW_KHZ[params[1]!] ?? 0) * 1000
          this.crDen = this.decodeCr(params[2]!)
          this.ctx?.emit({
            kind: 'cmd',
            summary: `Modulation SF${this.sf} BW${this.bwHz / 1000}k CR4/${this.crDen}`
          })
        }
        break
      case OP.SET_TX_PARAMS: {
        const raw = params[0] ?? 0
        this.txPowerDbm = raw > 127 ? raw - 256 : raw
        this.ctx?.emit({ kind: 'cmd', summary: `TX power ${this.txPowerDbm} dBm` })
        break
      }
      case OP.WRITE_BUFFER:
        this.txBuffer = params.slice()
        break
      case OP.CLEAR_RX_BUFFER:
        this.rxBuffer = new Uint8Array(0)
        this.rxLen = 0
        break
      case OP.SET_DIO_IRQ_PARAMS:
        // params = [irq1_31..0 (4), irq2_31..0 (4)] — DIO9 is irq1.
        if (params.length >= 4) {
          this.irqMask =
            ((params[0]! << 24) | (params[1]! << 16) | (params[2]! << 8) | params[3]!) >>> 0
        }
        break
      case OP.CLEAR_IRQ: {
        const clr = ((params[0]! << 24) | (params[1]! << 16) | (params[2]! << 8) | params[3]!) >>> 0
        this.irq = (this.irq & ~clr) >>> 0
        if ((this.irq & this.irqMask) === 0) this.ctx?.driveSignal('IRQ', 0)
        break
      }
      case OP.SET_TX: {
        this.mode = 'tx'
        this.txCount += 1
        const airtime = loraToaMs(this.sf, this.bwHz, this.crDen, this.txBuffer.length || 16)
        this.lastAirtimeMs = airtime
        this.raiseIrq(IRQ_TX_DONE)
        this.mode = 'standby' // RX/TX fallback to standby (config default)
        const decoded = decodeMeshFrame(this.txBuffer)
        const payloadHex = [...this.txBuffer].map((b) => b.toString(16).padStart(2, '0')).join('')
        this.ctx?.emit({
          kind: 'tx',
          summary: decoded
            ? `TX channel "${decoded.text}" (${this.txBuffer.length} B, ${airtime} ms)`
            : `TX ${this.txBuffer.length} B, ${airtime} ms airtime`,
          detail: {
            bytes: this.txBuffer.length,
            airtimeMs: airtime,
            freqHz: this.freqHz,
            payloadHex,
            ...(decoded ? { message: decoded.text, messageKind: decoded.kind } : {})
          }
        })
        break
      }
      case OP.SET_RX:
        this.mode = 'rx'
        this.ctx?.emit({ kind: 'rx', summary: 'RX mode' })
        break
      default:
        // A known but unmodelled config command (PA config, sync word, TCXO,
        // calibration, …). Accepted — not every register needs a model.
        break
    }
    void t
  }

  private decodeCr(raw: number): number {
    // RadioLib LR11X0_LORA_CR_*: 1..4 short (4/5..4/8), 5..7 long (4/5,4/6,4/8).
    const v = raw & 0x07
    if (v >= 1 && v <= 4) return v + 4 // 1→5, 2→6, 3→7, 4→8
    if (v === 5 || v === 6) return v // 5→4/5, 6→4/6
    if (v === 7) return 8 // 7→4/8
    return 5
  }

  private raiseIrq(bits: number): void {
    this.irq = (this.irq | bits) >>> 0
    if ((this.irq & this.irqMask) !== 0) this.ctx?.driveSignal('IRQ', 1)
  }

  private stat1(): number {
    return (STAT1_CMD_OK | (this.irq & this.irqMask ? STAT1_IRQ_ACTIVE : 0)) & 0xff
  }

  private stat2(): number {
    return (STAT2_RST_ANALOG | STAT2_MODE[this.mode] | STAT2_FLASH) & 0xff
  }

  // --- commands in (IN panel; Inspector config) ------------------------

  onCommand(command: string, args?: Record<string, unknown>): void {
    if (command === 'setParam') {
      // The four Inspector config fields, wired live (the general
      // Inspector-config mechanism is M12; this is four fields by hand).
      const bw = num(args?.['bw'])
      const sf = num(args?.['sf'])
      const cr = num(args?.['cr'])
      const txPower = num(args?.['txPower'])
      if (bw !== undefined) this.bwHz = bw * 1000
      if (sf !== undefined) this.sf = sf
      if (cr !== undefined) this.crDen = cr
      if (txPower !== undefined) this.txPowerDbm = txPower
      this.ctx?.emit({
        kind: 'cfg',
        summary: `Config SF${this.sf} BW${this.bwHz / 1000}k CR4/${this.crDen} ${this.txPowerDbm}dBm`
      })
      return
    }
    if (command === 'inject') {
      this.inject(args ?? {})
      return
    }
    this.ctx?.diagnose('warn', `LR1110: unknown command "${command}"`)
  }

  /**
   * IN-panel stimuli. `kind` is `advert` (a node advert from an address at N
   * hops), `channel` (a group text — `text`), `direct` (a one-to-one text —
   * `text`, `to`), `ack` (a delivery ack), or `noise` (a noise-floor burst, no
   * packet). Each carries the `rssi`/`snr` the
   * OUT panel reports. A packet fills the RX buffer, sets RX-done, and pulses
   * DIO9 so the guest's poll wakes; noise only moves the floor.
   */
  private inject(args: Record<string, unknown>): void {
    const kind = String(args['kind'] ?? 'channel')

    if (kind === 'noise') {
      this.noiseFloorDbm = num(args['floor']) ?? -100
      this.lastRssi = this.noiseFloorDbm
      this.ctx?.emit({
        kind: 'noise',
        summary: `Noise floor ${this.noiseFloorDbm} dBm`,
        detail: { floorDbm: this.noiseFloorDbm }
      })
      return
    }

    const frame = new Uint8Array(buildMeshFrame(kind, args))
    this.rxBuffer = frame
    this.rxLen = frame.length
    this.lastRssi = num(args['rssi']) ?? -80
    this.lastSnr = num(args['snr']) ?? 7
    this.lastAirtimeMs = loraToaMs(this.sf, this.bwHz, this.crDen, frame.length || 16)
    this.rxCount += 1
    // Raise RX-done regardless of mode — MeshCore arms continuous RX; if the
    // guest is not listening it will simply clear the flag.
    this.raiseIrq(IRQ_RX_DONE)
    const decoded = decodeMeshFrame(frame)
    this.ctx?.emit({
      kind: 'rx',
      summary: decoded
        ? `RX channel "${decoded.text}" ${frame.length} B  ${this.lastRssi} dBm / ${this.lastSnr} dB`
        : `RX ${kind} ${frame.length} B  ${this.lastRssi} dBm / ${this.lastSnr} dB`,
      detail: {
        kind,
        bytes: frame.length,
        rssiDbm: this.lastRssi,
        snrDb: this.lastSnr,
        airtimeMs: this.lastAirtimeMs,
        armed: this.mode === 'rx',
        ...(decoded ? { message: decoded.text } : {})
      }
    })
  }

  // --- observable state -----------------------------------------------

  snapshot(): DeviceSnapshot {
    return {
      mode: this.mode,
      packetType:
        this.packetType === PACKET_TYPE_LORA ? 'LoRa' : `0x${this.packetType.toString(16)}`,
      freqHz: this.freqHz,
      sf: this.sf,
      bwHz: this.bwHz,
      crDen: this.crDen,
      txPowerDbm: this.txPowerDbm,
      irqStatus: this.irq,
      lastRssi: this.lastRssi,
      lastSnr: this.lastSnr,
      lastAirtimeMs: this.lastAirtimeMs,
      noiseFloorDbm: this.noiseFloorDbm,
      rxCount: this.rxCount,
      txCount: this.txCount,
      resetCount: this.resetCount,
      nssLow: this.nssLow
    }
  }

  meter(id: string): number | undefined {
    switch (id) {
      case 'freq':
        return this.freqHz
      case 'rssi':
        return this.lastRssi
      case 'airtime':
        return this.lastAirtimeMs
      case 'busShare':
        return this.bytesOnBus > 0 ? 100 : 0
      default:
        return undefined
    }
  }
}

function isAllZero(a: Uint8Array): boolean {
  for (const b of a) if (b !== 0) return false
  return true
}

function isAllZeroArray(a: readonly number[]): boolean {
  if (a.length === 0) return false
  for (const b of a) if (b !== 0) return false
  return true
}

/**
 * A mesh frame for an IN-panel stimulus, shaped like a real MeshCore wire
 * packet so a live guest's dispatcher accepts it as a receive rather than
 * rejecting it as a runt. Layout follows `mesh::Packet::readFrom`:
 * `[header, path_len, ...payload]`, header = route (bits 1:0) | type (bits
 * 5:2) | ver (bits 7:6). `kind` is `advert`, `ack`, `channel` (a group text,
 * type 0x05) or `direct` (a one-to-one text, type 0x02). Verified against a
 * live Heltec/SX1262 MeshCore repeater: injecting a frame drives DIO1, the
 * guest's GPIO ISR runs, and `Dispatcher::checkRecv()` reads and parses it —
 * the packet log shows `type=5` for `channel`, `type=2` for `direct`. Shared
 * with the SX1262 model, whose IN panel offers the same stimuli.
 *
 * `advert` and `ack` are structurally valid but carry no real signature or MAC,
 * so the firmware logs the receive and then drops the packet — a faithful "a
 * message arrived, but not one for this node" without needing the sender's
 * keys. `channel`, `pair` and `direct` are the real thing:
 *   - `channel` — a decryptable GRP_TXT for MeshCore's built-in "Public" group;
 *     a companion guest parses it and renders the text.
 *   - `pair` — an Ed25519-signed advert for a fixed synthetic "PinBench" sender;
 *     an auto-add companion registers it as a contact.
 *   - `direct` — a one-to-one TXT_MSG encrypted with the X25519 secret the guest
 *     derives for that contact, so it renders once the guest has been `pair`ed.
 *     Needs `guestPub` — the recipient's 32-byte identity key, hex. The main
 *     process fills it by probing the booted companion (`mesh-companion.ts`);
 *     the radio IN panel's "Recipient key" field overrides. Without a key the
 *     frame is emitted but decrypts nowhere and the host raises a diagnostic.
 */
export function buildMeshFrame(kind: string, args: Record<string, unknown>): Uint8Array {
  const from = (num(args['from']) ?? 0x0a1b2c3d) >>> 0
  const hops = Math.max(0, Math.min(7, num(args['hops']) ?? 0))
  const src = [from >>> 24, (from >>> 16) & 0xff, (from >>> 8) & 0xff, from & 0xff]
  // ROUTE_TYPE_FLOOD (0x01), path_len 0.
  if (kind === 'advert') {
    // header: FLOOD | PAYLOAD_TYPE_ADVERT(0x04)<<2 == 0x11.
    return Uint8Array.from([0x11, 0x00, ...src, hops, 0x00])
  }
  if (kind === 'ack') {
    // header: FLOOD | PAYLOAD_TYPE_ACK(0x03)<<2 == 0x0d; payload = 4-byte CRC.
    return Uint8Array.from([0x0d, 0x00, ...src])
  }
  if (kind === 'pair') {
    // A real signed advert for the synthetic sender → the guest auto-adds it as
    // a contact so a later `direct` message from it decrypts. header: FLOOD |
    // PAYLOAD_TYPE_ADVERT(0x04)<<2 == 0x11.
    const name = typeof args['sender'] === 'string' ? (args['sender'] as string) : 'pinbench'
    const ts = num(args['timestamp']) ?? Math.floor(Date.now() / 1000)
    return Uint8Array.from([0x11, 0x00, ...signedAdvert(name, ts)])
  }
  const text = typeof args['text'] === 'string' ? (args['text'] as string) : 'trailhead in 20'

  // direct text message → header: FLOOD | PAYLOAD_TYPE_TXT_MSG(0x02)<<2 == 0x09;
  // payload = [dest_hash][src_hash][2-byte MAC][ciphertext]. Encrypted with the
  // X25519 secret the recipient derives for our synthetic sender, so it only
  // decodes once a `pair` advert has registered that sender as a contact.
  if (kind === 'direct') {
    const guestPubHex = typeof args['guestPub'] === 'string' ? (args['guestPub'] as string) : ''
    if (/^[0-9a-fA-F]{64}$/.test(guestPubHex)) {
      const ts = num(args['timestamp']) ?? Math.floor(Date.now() / 1000)
      return directTxtFrame(Buffer.from(guestPubHex, 'hex'), text, ts)
    }
    // No recipient key (discovery not wired, or the guest is not a companion
    // node). Emit a structurally valid frame that just won't decrypt anywhere —
    // the host raises a diagnostic so the blank guest screen is explained.
    const body = new TextEncoder().encode(text)
    const cipher = new Uint8Array(Math.max(16, body.length))
    cipher.set(body.subarray(0, cipher.length))
    return Uint8Array.from([0x09, 0x00, 0x00, senderIdentity().pub[0]!, 0x00, 0x00, ...cipher])
  }

  // channel message → header: FLOOD | PAYLOAD_TYPE_GRP_TXT(0x05)<<2 == 0x15;
  // payload = [channel hash][2-byte MAC][ciphertext], all real so the guest
  // decrypts it against the Public channel and shows the text.
  const sender = typeof args['sender'] === 'string' ? (args['sender'] as string) : 'pinbench'
  const ts = num(args['timestamp']) ?? Math.floor(Date.now() / 1000)
  return Uint8Array.from([0x15, 0x00, ...publicChannelPayload(text, sender, ts)])
}

/**
 * MeshCore's built-in "Public" group channel PSK — the key every companion node
 * pre-provisions (`examples/companion_radio/MyMesh.cpp` `PUBLIC_GROUP_PSK`).
 * 16 bytes; the HMAC key is this padded to 32 with zeroes (`PUB_KEY_SIZE`).
 */
const PUBLIC_GROUP_PSK = Buffer.from('izOH6cXN6mrJ5e26oRXNcg==', 'base64')

/**
 * A real, decryptable GRP_TXT payload for the Public channel:
 * `[channel-hash][2-byte MAC][AES-128-ECB ciphertext]`, the ciphertext over
 * `[LE32 timestamp][0x00 = TXT_TYPE_PLAIN]["<sender>: <text>\0"]` zero-padded to
 * a 16-byte block. Mirrors `src/Mesh.cpp` `createGroupDatagram` +
 * `Utils::encryptThenMAC`; decoded by `BaseChatMesh::onGroupDataRecv`. The
 * channel hash is `sha256(PSK)[0]` (`BaseChatMesh::addChannel`), the MAC is
 * `HMAC-SHA256(PSK‖zero(16), ciphertext)[:2]`.
 */
function publicChannelPayload(text: string, sender: string, timestamp: number): Uint8Array {
  const hmacKey = Buffer.concat([PUBLIC_GROUP_PSK, Buffer.alloc(16)])
  const channelHash = createHash('sha256').update(PUBLIC_GROUP_PSK).digest()[0]

  const body = Buffer.from(`${sender}: ${text}\0`, 'utf8')
  const plain = Buffer.concat([Buffer.alloc(5), body])
  plain.writeUInt32LE(timestamp >>> 0, 0)
  plain[4] = 0 // TXT_TYPE_PLAIN
  const padded = Buffer.alloc(Math.ceil(plain.length / 16) * 16)
  plain.copy(padded)

  const aes = createCipheriv('aes-128-ecb', PUBLIC_GROUP_PSK, null)
  aes.setAutoPadding(false)
  const ciphertext = Buffer.concat([aes.update(padded), aes.final()])
  const mac = createHmac('sha256', hmacKey).update(ciphertext).digest().subarray(0, 2)
  return Uint8Array.from([channelHash, ...mac, ...ciphertext])
}

/** A decoded MeshCore message lifted off the wire (see {@link decodeMeshFrame}). */
export interface DecodedMeshMessage {
  /** Only `channel` is decrypted today; other recognised types report their name. */
  kind: 'channel'
  /** The plaintext, sender prefix included (`"<sender>: <body>"`). */
  text: string
  /** The `TXT_TYPE_PLAIN` timestamp blob (seconds). */
  ts: number
  /** The single channel-hash byte the frame carried. */
  channelHash: number
}

/**
 * Inverse of {@link buildMeshFrame} for the wire, not the builder: parse a raw
 * MeshCore packet — `[header, path_len, ...path[path_len], ...payload]` — and,
 * when it is a GRP_TXT (`type 0x05`) for the built-in Public channel, MAC-check
 * and AES-128-ECB decrypt it. Returns `null` for any frame that is not a
 * Public-channel group text or fails the MAC (a `direct` message, an advert, a
 * relayed frame for another channel, a runt). `path_len > 0` is handled — a
 * flood relay appends its hash and bumps `path_len`, so the payload does not
 * start at offset 2. Used to surface the plaintext of a `channel` message the
 * firmware *sends* (or re-floods) in the radio OUT-panel event log.
 */
export function decodeMeshFrame(bytes: Uint8Array): DecodedMeshMessage | null {
  if (bytes.length < 3) return null
  const header = bytes[0]!
  const type = (header >> 2) & 0x0f
  const pathLen = bytes[1]!
  const payloadStart = 2 + pathLen
  if (payloadStart + 3 > bytes.length) return null

  // PAYLOAD_TYPE_GRP_TXT — [channel-hash][MAC(2)][AES-128-ECB ciphertext].
  if (type !== 0x05) return null
  const payload = Buffer.from(bytes.slice(payloadStart))
  const channelHash = payload[0]!
  const mac = payload.subarray(1, 3)
  const ciphertext = payload.subarray(3)
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) return null

  const hmacKey = Buffer.concat([PUBLIC_GROUP_PSK, Buffer.alloc(16)])
  const want = createHmac('sha256', hmacKey).update(ciphertext).digest().subarray(0, 2)
  if (Buffer.compare(mac, want) !== 0) return null

  const aes = createDecipheriv('aes-128-ecb', PUBLIC_GROUP_PSK, null)
  aes.setAutoPadding(false)
  const plain = Buffer.concat([aes.update(ciphertext), aes.final()])
  if (plain.length < 5) return null
  if (plain[4]! >> 2 !== 0) return null // not TXT_TYPE_PLAIN
  const nul = plain.indexOf(0, 5)
  return {
    kind: 'channel',
    ts: plain.readUInt32LE(0),
    channelHash,
    text: plain.toString('utf8', 5, nul === -1 ? plain.length : nul)
  }
}

// --- direct (one-to-one) messages -----------------------------------
//
// MeshCore's direct path (`Mesh::onRecvPacket` PAYLOAD_TYPE_TXT_MSG) needs the
// sender to be a known contact: it looks the contact up by `src_hash`, derives
// an X25519 secret from the two identities and MAC-then-decrypts. So `direct`
// only lands once the guest has been `pair`ed with our synthetic sender.

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

/** The one fixed synthetic sender — deterministic so a paired guest keeps it. */
const SENDER_SEED = createHash('sha256').update('pinbench-lora-direct-sender/v1').digest()

interface SenderIdentity {
  edPrv: ReturnType<typeof createPrivateKey>
  pub: Buffer // 32-byte Ed25519 public key
  x25519Scalar: Buffer // clamped Curve25519 scalar (SHA-512(seed)[:32])
}
let senderCache: SenderIdentity | null = null

function senderIdentity(): SenderIdentity {
  if (senderCache) return senderCache
  const edPrv = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, SENDER_SEED]),
    format: 'der',
    type: 'pkcs8'
  })
  const jwk = createPublicKey(edPrv).export({ format: 'jwk' }) as { x: string }
  const pub = Buffer.from(jwk.x, 'base64url')
  // Curve25519 scalar per RFC 8032 / orlp ed25519: clamp(SHA-512(seed)[:32]).
  const h = createHash('sha512').update(SENDER_SEED).digest()
  h[0]! &= 248
  h[31]! &= 63
  h[31]! |= 64
  senderCache = { edPrv, pub, x25519Scalar: h.subarray(0, 32) }
  return senderCache
}

const FIELD_P = (1n << 255n) - 19n
const modP = (a: bigint): bigint => ((a % FIELD_P) + FIELD_P) % FIELD_P
function powP(base: bigint, exp: bigint): bigint {
  let r = 1n
  let b = modP(base)
  let e = exp
  while (e > 0n) {
    if (e & 1n) r = modP(r * b)
    b = modP(b * b)
    e >>= 1n
  }
  return r
}
const leToBig = (buf: Uint8Array): bigint => {
  let x = 0n
  for (let i = buf.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(buf[i]!)
  return x
}
const bigToLe32 = (x: bigint): Buffer => {
  const b = Buffer.alloc(32)
  let v = x
  for (let i = 0; i < 32; i++) {
    b[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return b
}

/**
 * Ed25519 public key (Edwards y) → Curve25519 u, `u = (1 + y) / (1 - y) mod p`,
 * exactly `ed25519_key_exchange()` in `lib/ed25519/key_exchange.c` (sign bit of
 * `y` is ignored, as `fe_frombytes` does).
 */
function edPubToMontU(edPub: Buffer): Buffer {
  const y = modP(leToBig(edPub) & ((1n << 255n) - 1n))
  const u = modP((1n + y) * powP(modP(1n - y), FIELD_P - 2n))
  return bigToLe32(u)
}

/** X25519(scalar, u) via Node crypto — same result as the guest's key exchange. */
function x25519(scalar: Buffer, uLe32: Buffer): Buffer {
  const privateKey = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, scalar]),
    format: 'der',
    type: 'pkcs8'
  })
  const publicKey = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, uLe32]),
    format: 'der',
    type: 'spki'
  })
  return diffieHellman({ privateKey, publicKey })
}

/**
 * A signed advert payload for the synthetic sender:
 * `[pub_key(32)][timestamp(4 LE)][signature(64)][app_data]`, `app_data` =
 * `[ADV_TYPE_CHAT | ADV_NAME_MASK][name]` (`AdvertDataBuilder::encodeTo`). The
 * signature is Ed25519 over `pub_key ‖ timestamp ‖ app_data`.
 */
function signedAdvert(name: string, timestamp: number): Uint8Array {
  const { edPrv, pub } = senderIdentity()
  const appData = Buffer.concat([Buffer.from([0x01 | 0x80]), Buffer.from(name, 'utf8')])
  const ts = Buffer.alloc(4)
  ts.writeUInt32LE(timestamp >>> 0, 0)
  const message = Buffer.concat([pub, ts, appData])
  const signature = edSign(null, message, edPrv)
  return Uint8Array.from([...pub, ...ts, ...signature, ...appData])
}

/**
 * A decryptable direct TXT_MSG for `guestPub`:
 * `[dest_hash][src_hash][MAC(2)][AES-128-ECB ciphertext]`, ciphertext over
 * `[LE32 timestamp][0x00 = attempt/TXT_TYPE_PLAIN][text]` zero-padded to a
 * 16-byte block (`BaseChatMesh::composeMsgPacket` + `Mesh::createDatagram`).
 * The shared secret is `X25519(sender_scalar, edPubToMontU(guestPub))` — the
 * same value the guest derives via `getPeerSharedSecret`.
 */
function directTxtFrame(guestPub: Buffer, text: string, timestamp: number): Uint8Array {
  const { pub } = senderIdentity()
  const secret = x25519(senderIdentity().x25519Scalar, edPubToMontU(guestPub))

  const body = Buffer.from(text, 'utf8')
  const plain = Buffer.alloc(5 + body.length)
  plain.writeUInt32LE(timestamp >>> 0, 0)
  plain[4] = 0 // attempt 0 → flags == TXT_TYPE_PLAIN
  body.copy(plain, 5)
  const padded = Buffer.alloc(Math.ceil(plain.length / 16) * 16)
  plain.copy(padded)

  const aes = createCipheriv('aes-128-ecb', secret.subarray(0, 16), null)
  aes.setAutoPadding(false)
  const ciphertext = Buffer.concat([aes.update(padded), aes.final()])
  const mac = createHmac('sha256', secret).update(ciphertext).digest().subarray(0, 2)
  return Uint8Array.from([0x09, 0x00, guestPub[0]!, pub[0]!, ...mac, ...ciphertext])
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

export const lr1110Descriptor: DeviceModelDescriptor = {
  id: 'semtech.lr1110',
  summary:
    'Semtech LR1110 LoRa transceiver on SPI. LR11x0 16-bit-opcode command framing, GetVersion handshake, standby/tx/rx modes, LoRa modulation params, IRQ/DIO9 assertion, airtime meter; unimplemented opcodes raise a named diagnostic.',
  create: (options) => new Lr1110Model(lr1110Options(options))
}
