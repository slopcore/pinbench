/**
 * Hynitron CST816S — the single-point capacitive touch controller on the
 * Waveshare ESP32-C6-Touch-LCD-1.28 (I2C 0x15, INT GPIO4, RST GPIO23).
 *
 * ## Shape of the traffic
 *
 * Waveshare's driver (Felix Biego's CST816S library, as shipped in their
 * Arduino LVGL demo) is a plain register device behind Wire:
 *
 *   - `begin()` pulses RST, then reads `0x15` (1 byte) and `0xA7` (3 bytes:
 *     chip id, project id, firmware version), and attaches a FALLING ISR to
 *     INT;
 *   - the ISR only sets a flag; LVGL's indev read then calls `read_touch()`,
 *     which reads 6 bytes from `0x01`: gesture, finger count, event<<6 | X[11:8],
 *     X[7:0], Y[11:8], Y[7:0].
 *
 * Each I2C address phase reaches {@link onBus} separately (protocol `Op.I2c`),
 * so a register read is a 1-byte write that sets the pointer followed by a
 * read that streams from it with auto-increment — as on the part.
 *
 * ## INT
 *
 * The part reports each touch event with a low pulse on INT. Drivers attach to
 * either edge — Waveshare's `begin()` defaults to RISING, so the report must be
 * readable by the time INT rises, and INT must rise without waiting for a read.
 * PinBench's GPIO edge latch only notices a host-driven level when the guest
 * polls or on its 10 ms virtual-time timer, so the pulse is `pulseMs` (default
 * 50 ms) wide rather than the silicon's few microseconds: long enough that
 * both edges are latched.
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

export const CST816S_ADDRESS = 0x15

const REG_GESTURE = 0x01
const REG_FINGER_NUM = 0x02
const REG_XPOS_H = 0x03
const REG_YPOS_L = 0x06
const REG_VERSION = 0x15
const REG_CHIP_ID = 0xa7
const REG_PROJ_ID = 0xa8
const REG_FW_VERSION = 0xa9

const CHIP_ID = 0xb5

/** Gesture codes, as Waveshare's `enum class Gesture`. */
export const GESTURES: Record<string, number> = {
  none: 0x00,
  'swipe-up': 0x01,
  'swipe-down': 0x02,
  'swipe-left': 0x03,
  'swipe-right': 0x04,
  click: 0x05,
  'double-click': 0x0b,
  'long-press': 0x0c
}

const EVENT_DOWN = 0
const EVENT_UP = 1

export interface Cst816sOptions {
  /** Panel size the coordinates are clamped to. Default 240 × 240. */
  width?: number
  height?: number
  /** How long `tap` holds the finger down before lifting, ms. Default 120. */
  tapMs?: number
  /** Width of the INT low pulse per report, ms. Default 50. */
  pulseMs?: number
}

function cst816sOptions(raw?: Record<string, unknown>): Cst816sOptions {
  const o: Cst816sOptions = {}
  for (const key of ['width', 'height', 'tapMs', 'pulseMs'] as const) {
    if (typeof raw?.[key] === 'number') o[key] = raw[key]
  }
  return o
}

export class Cst816sModel implements DeviceModel {
  readonly id = 'hynitron.cst816s'
  readonly i2cAddress = CST816S_ADDRESS
  readonly outputSignals: readonly string[] = ['INT']
  readonly meters: readonly MeterDeclaration[] = [
    { id: 'touches', label: 'Touches' },
    { id: 'reads', label: 'Reports read' }
  ]

  private readonly width: number
  private readonly height: number
  private readonly tapMs: number
  private readonly pulseMs: number
  private ctx: DeviceContext | null = null
  private regs = new Uint8Array(256)
  private pointer = 0
  private intLow = false
  private inReset = false
  private touches = 0
  private reads = 0
  private lastX = 0
  private lastY = 0
  private down = false
  private tapTimer: ReturnType<typeof setTimeout> | null = null
  private pulseTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: Cst816sOptions = {}) {
    this.width = options.width ?? 240
    this.height = options.height ?? 240
    this.tapMs = options.tapMs ?? 120
    this.pulseMs = options.pulseMs ?? 50
    this.powerOn()
  }

  attach(ctx: DeviceContext): void {
    this.ctx = ctx
    this.powerOn()
    ctx.driveSignal('INT', 1)
  }

  reset(): void {
    this.clearTimer()
    this.powerOn()
    this.setInt(false)
  }

  detach(): void {
    this.clearTimer()
    this.ctx = null
  }

  private powerOn(): void {
    this.regs = new Uint8Array(256)
    this.regs[REG_VERSION] = 0x01
    this.regs[REG_CHIP_ID] = CHIP_ID
    this.regs[REG_PROJ_ID] = 0x00
    this.regs[REG_FW_VERSION] = 0x01
    this.pointer = 0
    this.down = false
  }

  // --- lines in ------------------------------------------------------------

  onSignal(edge: SignalEdge): void {
    switch (edge.signal) {
      case 'RST':
        // Active-low reset: asserting it clears any pending report.
        if (edge.level === 0) {
          this.inReset = true
          this.clearTimer()
          this.powerOn()
          this.setInt(false)
        } else if (this.inReset) {
          this.inReset = false
          this.ctx?.emit({ kind: 'reset', summary: 'Touch reset (RST)' })
        }
        return
      case 'SDA':
      case 'SCL':
      case 'INT':
        // Bus lines and our own output: their pin-enable edges are not events.
        return
      default:
        this.ctx?.diagnose('warn', `CST816S has no line "${edge.signal}"`)
    }
  }

  // --- bus in ------------------------------------------------------------

  onBus(txn: BusTransaction): BusResponse {
    if (txn.read) {
      const miso = new Uint8Array(txn.mosi.length)
      for (let i = 0; i < miso.length; i++) miso[i] = this.regs[(this.pointer + i) & 0xff]!
      if (this.pointer <= REG_YPOS_L && this.pointer + miso.length > REG_GESTURE) {
        this.reads += 1
      }
      this.pointer = (this.pointer + miso.length) & 0xff
      return { miso }
    }
    // A write: first byte sets the register pointer, the rest are data.
    this.pointer = txn.mosi[0]!
    for (let i = 1; i < txn.mosi.length; i++) {
      this.regs[this.pointer] = txn.mosi[i]!
      this.pointer = (this.pointer + 1) & 0xff
    }
    return { miso: new Uint8Array(txn.mosi.length) }
  }

  // --- IN panel / canvas -----------------------------------------------------

  onCommand(command: string, args?: Record<string, unknown>): void {
    const x = clampInt(args?.['x'], this.lastX, this.width - 1)
    const y = clampInt(args?.['y'], this.lastY, this.height - 1)
    switch (command) {
      case 'touch':
        this.report(EVENT_DOWN, x, y, gestureCode(args?.['gesture']))
        return
      case 'release':
        this.report(EVENT_UP, this.lastX, this.lastY, GESTURES['none']!)
        return
      case 'tap':
        this.clearTimer()
        this.report(EVENT_DOWN, x, y, GESTURES['click']!)
        this.tapTimer = setTimeout(() => {
          this.tapTimer = null
          this.report(EVENT_UP, x, y, GESTURES['click']!)
        }, this.tapMs)
        return
      case 'gesture':
        this.report(EVENT_UP, x, y, gestureCode(args?.['name']))
        return
      default:
        this.ctx?.diagnose('warn', `CST816S: unknown command "${command}"`)
    }
  }

  private report(event: number, x: number, y: number, gesture: number): void {
    this.lastX = x
    this.lastY = y
    this.down = event === EVENT_DOWN
    if (this.down) this.touches += 1
    this.regs[REG_GESTURE] = gesture
    this.regs[REG_FINGER_NUM] = this.down ? 1 : 0
    this.regs[REG_XPOS_H] = ((event & 0x3) << 6) | ((x >> 8) & 0x0f)
    this.regs[REG_XPOS_H + 1] = x & 0xff
    this.regs[REG_XPOS_H + 2] = (y >> 8) & 0x0f
    this.regs[REG_YPOS_L] = y & 0xff
    this.ctx?.emit({
      kind: this.down ? 'touch' : 'release',
      summary: `${this.down ? 'Touch' : 'Lift'} at (${x}, ${y})${gesture ? ` gesture 0x${gesture.toString(16)}` : ''}`
    })
    this.pulseInt()
  }

  /** One INT report pulse: low now, high again after `pulseMs`. */
  private pulseInt(): void {
    if (this.pulseTimer) clearTimeout(this.pulseTimer)
    this.setInt(true)
    this.pulseTimer = setTimeout(() => {
      this.pulseTimer = null
      this.setInt(false)
    }, this.pulseMs)
  }

  private setInt(low: boolean): void {
    if (low === this.intLow) return
    this.intLow = low
    this.ctx?.driveSignal('INT', low ? 0 : 1)
  }

  private clearTimer(): void {
    if (this.tapTimer) clearTimeout(this.tapTimer)
    if (this.pulseTimer) clearTimeout(this.pulseTimer)
    this.tapTimer = null
    this.pulseTimer = null
  }

  // --- observable state -------------------------------------------------

  snapshot(): DeviceSnapshot {
    return {
      touched: this.down,
      x: this.lastX,
      y: this.lastY,
      gesture: this.regs[REG_GESTURE],
      intLow: this.intLow,
      pointer: this.pointer
    }
  }

  meter(id: string): number | undefined {
    if (id === 'touches') return this.touches
    if (id === 'reads') return this.reads
    return undefined
  }
}

function clampInt(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : fallback
  return n < 0 ? 0 : n > max ? max : n
}

function gestureCode(raw: unknown): number {
  if (typeof raw === 'number') return raw & 0xff
  if (typeof raw === 'string' && raw in GESTURES) return GESTURES[raw]!
  return GESTURES['none']!
}

export const cst816sDescriptor: DeviceModelDescriptor = {
  id: 'hynitron.cst816s',
  summary:
    'CST816S capacitive touch on I2C 0x15: register file with auto-increment pointer, chip id 0xB5, 6-byte touch report at 0x01, gestures, active-low INT pulse per report.',
  create: (options) => new Cst816sModel(cst816sOptions(options))
}
