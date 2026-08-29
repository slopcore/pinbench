/**
 * Semtech SX1262 — the Heltec Wireless Paper v1.1's sub-GHz LoRa transceiver
 * (roadmap M13), and the part that tests whether M7's radio work was an
 * abstraction or just an LR1110 driver. It sits on its own SPI bus
 * (`spi-radio`: SCLK GPIO9, MOSI GPIO10, MISO GPIO11) behind `NSS` (GPIO8),
 * with `BUSY` (GPIO13) and `DIO1` (GPIO14) as discrete lines. There is no wired
 * reset — the board's `P_LORA_RESET` is `RADIOLIB_NC`.
 *
 * ## Shape of the traffic — and how it differs from the LR1110
 *
 * MeshCore drives it through RadioLib's `SX126x` module (`CustomSX1262Wrapper`,
 * `RADIOLIB_STATIC_ONLY`). Framing confirmed against the checkout's own
 * `RadioLib/src/modules/SX126x/` and `Module::SPItransferStream`:
 *
 *   - Opcodes are **8-bit**, not the LR11x0's 16-bit — one leading byte per
 *     `NSS`-low..`NSS`-high group, which is one {@link onBus} transaction.
 *   - There is **no separate status poll**: every transaction returns a status
 *     byte in-band. RadioLib reads it at buffer position 1 (`statusPos = 1`),
 *     so `miso[1]` must always parse clean — `SPIparseStatus` rejects
 *     `CMD_TIMEOUT` (`0b110`), `CMD_INVALID` (`0b100...`), `CMD_FAILED`
 *     (`0b101...`) in bits 3:1. This model fills the whole `miso` buffer with a
 *     valid status and overlays real payload for read commands.
 *   - **Read framing**: for a stream read the payload lands at
 *     `miso[cmdLen + 1]` (one status byte after the command bytes) — offset 2
 *     for `GET_*`, offset 3 for `READ_BUFFER` (`[0x1E, offset]`), offset 4 for
 *     `READ_REGISTER` (`[0x1D, addrHi, addrLo]`).
 *   - **`findChip`** reads 16 bytes from register `0x0320` and does
 *     `strncmp(chipType, version, 6)`. RadioLib's `chipType` for the SX1262 is
 *     the string `"SX1262"` — so the version register must read back `SX1262`.
 *   - **`BUSY`** is held high by the real part while it digests a command;
 *     RadioLib waits on it before every transfer. Modelled the same way the
 *     LR1110's `BUSY` is: pulsed around the (synchronous) command so a trace
 *     shows it, released by the time the guest polls (a v1 non-goal is real
 *     wall-clock stalls). `DIO1` is the IRQ line, asserted on TX/RX done.
 *
 * Airtime is the shared {@link loraToaMs} from the LR1110 model — the SX126x
 * and LR11x0 LoRa PHYs use the same Semtech time-on-air maths, and duplicating
 * it here would be the failure signal M13 is looking for. Every opcode outside
 * the known set raises a loud named diagnostic (M7's rule).
 */

import { buildMeshFrame, loraToaMs } from './lr1110'
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

// --- SX126x command opcodes (RadioLib SX126x_commands.h) --------------------

const OP = {
  NOP: 0x00,
  SET_SLEEP: 0x84,
  SET_STANDBY: 0x80,
  SET_FS: 0xc1,
  SET_TX: 0x83,
  SET_RX: 0x82,
  STOP_TIMER_ON_PREAMBLE: 0x9f,
  SET_RX_DUTY_CYCLE: 0x94,
  SET_CAD: 0xc5,
  SET_TX_CONTINUOUS_WAVE: 0xd1,
  SET_TX_INFINITE_PREAMBLE: 0xd2,
  SET_REGULATOR_MODE: 0x96,
  CALIBRATE: 0x89,
  CALIBRATE_IMAGE: 0x98,
  SET_PA_CONFIG: 0x95,
  SET_RX_TX_FALLBACK_MODE: 0x93,
  WRITE_REGISTER: 0x0d,
  READ_REGISTER: 0x1d,
  WRITE_BUFFER: 0x0e,
  READ_BUFFER: 0x1e,
  SET_DIO_IRQ_PARAMS: 0x08,
  GET_IRQ_STATUS: 0x12,
  CLEAR_IRQ_STATUS: 0x02,
  SET_DIO2_AS_RF_SWITCH: 0x9d,
  SET_DIO3_AS_TCXO: 0x97,
  SET_RF_FREQUENCY: 0x86,
  SET_PACKET_TYPE: 0x8a,
  GET_PACKET_TYPE: 0x11,
  SET_TX_PARAMS: 0x8e,
  SET_MODULATION_PARAMS: 0x8b,
  SET_PACKET_PARAMS: 0x8c,
  SET_CAD_PARAMS: 0x88,
  SET_BUFFER_BASE_ADDRESS: 0x8f,
  SET_LORA_SYMB_NUM_TIMEOUT: 0xa0,
  GET_STATUS: 0xc0,
  GET_RSSI_INST: 0x15,
  GET_RX_BUFFER_STATUS: 0x13,
  GET_PACKET_STATUS: 0x14,
  GET_DEVICE_ERRORS: 0x17,
  CLEAR_DEVICE_ERRORS: 0x07,
  GET_STATS: 0x10
} as const

const KNOWN_OPS = new Set<number>(Object.values(OP))

/** Reads whose payload sits at `miso[cmdLen + 1]`; value = cmdLen. */
const READ_CMD_LEN: Record<number, number> = {
  [OP.GET_STATUS]: 1,
  [OP.GET_IRQ_STATUS]: 1,
  [OP.GET_RX_BUFFER_STATUS]: 1,
  [OP.GET_PACKET_STATUS]: 1,
  [OP.GET_RSSI_INST]: 1,
  [OP.GET_DEVICE_ERRORS]: 1,
  [OP.GET_PACKET_TYPE]: 1,
  [OP.GET_STATS]: 1,
  [OP.READ_BUFFER]: 2, // [0x1E, offset]
  [OP.READ_REGISTER]: 3 // [0x1D, addrHi, addrLo]
}

// Status byte (SX126x_commands.h): bits 6:4 chip mode, bits 3:1 command status.
const STATUS_MODE = {
  standby: 0x20, // STDBY_RC
  standbyXosc: 0x30,
  fs: 0x40,
  rx: 0x50,
  tx: 0x60
} as const
const STATUS_CMD_DATA_AVAILABLE = 0x04
const STATUS_CMD_OK = 0x02 // "reserved / OK" — not one of the three failure codes

// IRQ bits (16-bit).
const IRQ_TX_DONE = 0x0001
const IRQ_RX_DONE = 0x0002

// LoRa modulation-param decode.
const BW_HZ: Record<number, number> = { 0x04: 125000, 0x05: 250000, 0x06: 500000 }
const CR_DEN: Record<number, number> = {
  0x01: 5,
  0x02: 6,
  0x03: 7,
  0x04: 8,
  0x05: 5,
  0x06: 6,
  0x07: 8
}

const PACKET_TYPE_LORA = 0x01
const VERSION_REG = 0x0320
const CHIP_VERSION_STRING = 'SX1262'

type RadioMode = 'sleep' | 'standby' | 'fs' | 'rx' | 'tx'

export interface Sx1262Options {
  /** `SX126X_DIO2_AS_RF_SWITCH` — accepted as a no-op, recorded in the snapshot. */
  dio2RfSwitch?: boolean
  /** `SX126X_DIO3_TCXO_VOLTAGE` in volts — likewise. */
  dio3TcxoVoltage?: number
}

function sx1262Options(raw?: Record<string, unknown>): Sx1262Options {
  const o: Sx1262Options = {}
  if (typeof raw?.['dio2RfSwitch'] === 'boolean') o.dio2RfSwitch = raw['dio2RfSwitch']
  if (typeof raw?.['dio3TcxoVoltage'] === 'number') o.dio3TcxoVoltage = raw['dio3TcxoVoltage']
  return o
}

export class Sx1262Model implements DeviceModel {
  readonly id = 'semtech.sx1262'
  /** BUSY (GPIO13) and DIO1 (GPIO14) are inputs the SoC level-polls. */
  readonly outputSignals = ['BUSY', 'DIO1'] as const
  readonly meters: readonly MeterDeclaration[] = [
    { id: 'freq', label: 'Frequency', unit: 'Hz' },
    { id: 'rssi', label: 'Last RSSI', unit: 'dBm' },
    { id: 'airtime', label: 'Airtime', unit: 'ms' },
    { id: 'busShare', label: 'Bus share', unit: '%' }
  ]

  private ctx: DeviceContext | null = null
  private readonly opts: Sx1262Options

  // Line state.
  private nssLow = false

  // Controller state.
  private mode: RadioMode = 'standby'
  private packetType = PACKET_TYPE_LORA
  private freqHz = 0
  private sf = 0
  private bwHz = 0
  private crDen = 5
  private txPowerDbm = 0
  private payloadLen = 16
  private irq = 0
  private irqMask = 0xffff
  private lastRssi = -110
  private lastSnr = 0
  private lastAirtimeMs = 0

  // Buffers.
  private txBuffer = new Uint8Array(0)
  private rxBuffer = new Uint8Array(0)
  private rxLen = 0
  private noiseFloorDbm = -120
  private rxCount = 0
  private txCount = 0
  private resetCount = 0
  private bytesOnBus = 0

  constructor(options: Sx1262Options = {}) {
    this.opts = options
  }

  attach(ctx: DeviceContext): void {
    this.ctx = ctx
    this.powerOn()
  }

  reset(): void {
    this.resetCount += 1
    this.powerOn()
    this.ctx?.emit({ kind: 'reset', summary: 'Radio reset' })
  }

  detach(): void {
    this.ctx = null
  }

  private powerOn(): void {
    this.nssLow = false
    this.mode = 'standby'
    this.packetType = PACKET_TYPE_LORA
    this.freqHz = 0
    this.sf = 0
    this.bwHz = 0
    this.crDen = 5
    this.txPowerDbm = 0
    this.payloadLen = 16
    this.irq = 0
    this.irqMask = 0xffff
    this.lastRssi = -110
    this.lastSnr = 0
    this.lastAirtimeMs = 0
    this.txBuffer = new Uint8Array(0)
    this.rxBuffer = new Uint8Array(0)
    this.rxLen = 0
    this.noiseFloorDbm = -120
    this.ctx?.driveSignal('BUSY', 0)
    this.ctx?.driveSignal('DIO1', 0)
  }

  // --- lines in ----------------------------------------------------------

  onSignal(edge: SignalEdge): void {
    switch (edge.signal) {
      case 'NSS':
      case 'CS':
        this.nssLow = edge.level === 0
        return
      // No wired reset on this board; BUSY / DIO1 are device-driven.
      default:
        this.ctx?.diagnose('warn', `SX1262 has no input line "${edge.signal}"`)
    }
  }

  // --- bus in ----------------------------------------------------------

  onBus(txn: BusTransaction): BusResponse {
    const mosi = txn.mosi
    // Fill with a clean status byte so `statusPos` always parses, then overlay.
    const miso = new Uint8Array(mosi.length).fill(this.statusByte())
    this.bytesOnBus += mosi.length
    if (mosi.length === 0) return { miso }

    const op = mosi[0]!
    // BUSY high while the command is digested, low again before the guest polls.
    this.ctx?.driveSignal('BUSY', 1)

    if (op === OP.NOP) {
      this.ctx?.driveSignal('BUSY', 0)
      return { miso }
    }
    if (!KNOWN_OPS.has(op)) {
      this.ctx?.diagnose(
        'warn',
        `SX1262: unimplemented command 0x${op.toString(16).padStart(2, '0')}`
      )
      this.ctx?.driveSignal('BUSY', 0)
      return { miso }
    }

    if (op in READ_CMD_LEN) {
      this.fillRead(op, mosi, miso)
    } else {
      this.applyWrite(op, mosi.subarray(1), txn.t)
    }

    this.ctx?.driveSignal('BUSY', 0)
    return { miso }
  }

  private fillRead(op: number, mosi: Uint8Array, miso: Uint8Array): void {
    const at = READ_CMD_LEN[op]! + 1
    const put = (bytes: number[]): void => {
      for (let i = 0; i < bytes.length && at + i < miso.length; i++) miso[at + i] = bytes[i]!
    }
    switch (op) {
      case OP.GET_STATUS:
        // status byte already fills miso; nothing more to place.
        break
      case OP.GET_IRQ_STATUS:
        put([(this.irq >>> 8) & 0xff, this.irq & 0xff])
        break
      case OP.GET_RX_BUFFER_STATUS:
        put([this.rxLen & 0xff, 0x00]) // [payloadLengthRx, rxStartBufferPointer]
        break
      case OP.GET_PACKET_STATUS: {
        // LoRa: [rssiPkt, snrPkt, signalRssiPkt]; RadioLib: rssi = -raw/2, snr = int8/4.
        const rssiRaw = clampByte(Math.round(-2 * this.lastRssi))
        const snrRaw = Math.round(4 * this.lastSnr) & 0xff
        put([rssiRaw, snrRaw, rssiRaw])
        break
      }
      case OP.GET_RSSI_INST:
        put([clampByte(Math.round(-2 * this.lastRssi))])
        break
      case OP.GET_DEVICE_ERRORS:
        put([0x00, 0x00])
        break
      case OP.GET_PACKET_TYPE:
        put([this.packetType])
        break
      case OP.GET_STATS:
        put([0, 0, 0, 0, 0, 0])
        break
      case OP.READ_BUFFER: {
        const offset = mosi[1] ?? 0
        const slice = this.rxBuffer.subarray(offset)
        put([...slice])
        break
      }
      case OP.READ_REGISTER: {
        const addr = ((mosi[1] ?? 0) << 8) | (mosi[2] ?? 0)
        put(this.readRegister(addr, Math.max(0, miso.length - at)))
        break
      }
    }
  }

  private readRegister(addr: number, len: number): number[] {
    const out = new Array<number>(len).fill(0)
    // The only register RadioLib reads to identify the part.
    if (addr <= VERSION_REG && VERSION_REG < addr + len) {
      const s = CHIP_VERSION_STRING
      for (let i = 0; i < s.length; i++) {
        const idx = VERSION_REG - addr + i
        if (idx >= 0 && idx < len) out[idx] = s.charCodeAt(i)
      }
    }
    return out
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
      case OP.SET_RF_FREQUENCY: {
        const raw = ((params[0]! << 24) | (params[1]! << 16) | (params[2]! << 8) | params[3]!) >>> 0
        // f = raw * 32e6 / 2^25
        this.freqHz = Math.round((raw * 32_000_000) / 2 ** 25)
        this.ctx?.emit({ kind: 'cmd', summary: `Frequency ${(this.freqHz / 1e6).toFixed(3)} MHz` })
        break
      }
      case OP.SET_MODULATION_PARAMS:
        if (params.length >= 3) {
          this.sf = params[0]!
          this.bwHz = BW_HZ[params[1]!] ?? 0
          this.crDen = CR_DEN[params[2]!] ?? 5
          this.ctx?.emit({
            kind: 'cmd',
            summary: `Modulation SF${this.sf} BW${this.bwHz / 1000}k CR4/${this.crDen}`
          })
        }
        break
      case OP.SET_PACKET_PARAMS:
        // LoRa: [preambleHi, preambleLo, headerType, payloadLen, crcType, invertIQ]
        if (params.length >= 4) this.payloadLen = params[3]!
        break
      case OP.SET_TX_PARAMS: {
        const raw = params[0] ?? 0
        this.txPowerDbm = raw > 127 ? raw - 256 : raw
        this.ctx?.emit({ kind: 'cmd', summary: `TX power ${this.txPowerDbm} dBm` })
        break
      }
      case OP.WRITE_BUFFER:
        // params = [offset, ...data]
        this.txBuffer = params.slice(1)
        break
      case OP.SET_DIO_IRQ_PARAMS:
        // [irqMaskHi, irqMaskLo, dio1Hi, dio1Lo, dio2Hi, dio2Lo, dio3Hi, dio3Lo]
        if (params.length >= 4) {
          this.irqMask = ((params[2]! << 8) | params[3]!) & 0xffff
        }
        break
      case OP.CLEAR_IRQ_STATUS: {
        const clr = ((params[0]! << 8) | params[1]!) & 0xffff
        this.irq = this.irq & ~clr & 0xffff
        if ((this.irq & this.irqMask) === 0) this.ctx?.driveSignal('DIO1', 0)
        break
      }
      case OP.SET_TX: {
        this.mode = 'tx'
        this.txCount += 1
        const airtime = loraToaMs(
          this.sf,
          this.bwHz,
          this.crDen,
          this.txBuffer.length || this.payloadLen
        )
        this.lastAirtimeMs = airtime
        this.raiseIrq(IRQ_TX_DONE)
        this.mode = 'standby' // RX/TX fallback to standby (config default)
        this.ctx?.emit({
          kind: 'tx',
          summary: `TX ${this.txBuffer.length || this.payloadLen} B, ${airtime} ms airtime`,
          detail: { bytes: this.txBuffer.length, airtimeMs: airtime, freqHz: this.freqHz }
        })
        break
      }
      case OP.SET_RX:
        this.mode = 'rx'
        this.ctx?.emit({ kind: 'rx', summary: 'RX mode' })
        break
      case OP.SET_DIO2_AS_RF_SWITCH:
      case OP.SET_DIO3_AS_TCXO:
        // Board hardware options — accepted, not modelled. Not a diagnostic.
        break
      default:
        // Known but unmodelled config command (PA config, calibration, sync
        // word, regulator mode, …). Accepted.
        break
    }
    void t
  }

  private raiseIrq(bits: number): void {
    this.irq = (this.irq | bits) & 0xffff
    if ((this.irq & this.irqMask) !== 0) this.ctx?.driveSignal('DIO1', 1)
  }

  private statusByte(): number {
    const mode =
      this.mode === 'tx'
        ? STATUS_MODE.tx
        : this.mode === 'rx'
          ? STATUS_MODE.rx
          : this.mode === 'fs'
            ? STATUS_MODE.fs
            : STATUS_MODE.standby
    const cmd = this.rxLen > 0 ? STATUS_CMD_DATA_AVAILABLE : STATUS_CMD_OK
    return (mode | cmd) & 0xff
  }

  // --- commands in (IN panel) -----------------------------------------

  onCommand(command: string, args?: Record<string, unknown>): void {
    if (command === 'setParam') {
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
    this.ctx?.diagnose('warn', `SX1262: unknown command "${command}"`)
  }

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
    this.raiseIrq(IRQ_RX_DONE)
    this.ctx?.emit({
      kind: 'rx',
      summary: `RX ${kind} ${frame.length} B  ${this.lastRssi} dBm / ${this.lastSnr} dB`,
      detail: {
        kind,
        bytes: frame.length,
        rssiDbm: this.lastRssi,
        snrDb: this.lastSnr,
        airtimeMs: this.lastAirtimeMs,
        armed: this.mode === 'rx'
      }
    })
  }

  // --- observable state ---------------------------------------------

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
      dio2RfSwitch: this.opts.dio2RfSwitch ?? false,
      dio3TcxoVoltage: this.opts.dio3TcxoVoltage ?? 0,
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

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

export const sx1262Descriptor: DeviceModelDescriptor = {
  id: 'semtech.sx1262',
  summary:
    'Semtech SX1262 LoRa transceiver on SPI. SX126x 8-bit-opcode framing, in-band status byte, SX1262 version-register handshake, standby/tx/rx modes, LoRa modulation params, DIO1 IRQ, BUSY line, shared airtime maths; unimplemented opcodes raise a named diagnostic.',
  create: (options) => new Sx1262Model(sx1262Options(options))
}
