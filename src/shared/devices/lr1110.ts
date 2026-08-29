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

// IRQ bits (32-bit IRQ word). RX_DONE joins in M7.3 with frame injection.
const IRQ_TX_DONE = 0x01 << 2

// LoRa bandwidth register value → kHz (RadioLib LR11X0_LORA_BW_*).
const BW_KHZ: Record<number, number> = { 0x03: 62.5, 0x04: 125, 0x05: 250, 0x06: 500 }

type RadioMode = 'sleep' | 'standby' | 'fs' | 'rx' | 'tx'

export interface Lr1110Options {
  /** Hardware device byte `GetVersion` reports. `0x01` = LR1110 (default). */
  deviceId?: number
}

function lr1110Options(raw?: Record<string, unknown>): Lr1110Options {
  const o: Lr1110Options = {}
  if (typeof raw?.['deviceId'] === 'number') o.deviceId = raw['deviceId'] & 0xff
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

  // Line state.
  private nssLow = false
  private resetAsserted = false

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

  /** A read whose reply the next bare-NOP transaction will carry. */
  private pendingRead: Uint8Array | null = null

  private bytesOnBus = 0

  constructor(options: Lr1110Options = {}) {
    this.deviceId = options.deviceId ?? 0x01
  }

  attach(ctx: DeviceContext): void {
    this.ctx = ctx
    this.powerOn()
  }

  reset(): void {
    this.powerOn()
    this.ctx?.emit({ kind: 'reset', summary: 'Radio reset' })
  }

  detach(): void {
    this.ctx = null
  }

  private powerOn(): void {
    this.nssLow = false
    this.resetAsserted = false
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
    this.pendingRead = null
    this.ctx?.driveSignal('BUSY', 0)
    this.ctx?.driveSignal('IRQ', 0)
  }

  // --- lines in ----------------------------------------------------------

  onSignal(edge: SignalEdge): void {
    switch (edge.signal) {
      case 'NSS':
      case 'CS':
        this.nssLow = edge.level === 0
        return
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
    const miso = new Uint8Array(mosi.length)
    this.bytesOnBus += mosi.length

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

    this.applyWrite(op, params, txn.t)
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
        const airtime = loraToaMs(this.sf, this.bwHz, this.crDen, this.txBuffer.length || 16)
        this.lastAirtimeMs = airtime
        this.raiseIrq(IRQ_TX_DONE)
        this.mode = 'standby' // RX/TX fallback to standby (config default)
        this.ctx?.emit({
          kind: 'tx',
          summary: `TX ${this.txBuffer.length} B, ${airtime} ms airtime`,
          detail: { bytes: this.txBuffer.length, airtimeMs: airtime, freqHz: this.freqHz }
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
      // The four Inspector fields. Full IN-panel injection lands in M7.3.
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
    this.ctx?.diagnose('warn', `LR1110: unknown command "${command}"`)
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
