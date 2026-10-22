/**
 * Sitronix ST7789 — the M9's 2.4" 320×240 SPI panel, and the device that
 * justifies PinBench choosing full emulation (roadmap M6). The OUT panel shows
 * the pixels `ST7789Spi::display()` pushes while MeshCore's real UI code runs
 * on the emulated Xtensa core — not a lookalike drawn in TypeScript.
 *
 * ## Shape of the traffic
 *
 * MeshCore's `ST7789Spi` driver (an `OLEDDisplay` subclass) talks to the panel
 * one `SPI.transfer(uint8_t)` at a time, toggling the `DC` GPIO around each
 * group: `DC` low for a command byte, `DC` high for its parameters and for
 * `RAMWR` pixel data. Chip-select is a plain GPIO (`ST7789_CS` = GPIO16) the
 * driver drives with `digitalWrite`, so selection is tracked by the host from
 * {@link Op.Gpio} edges, not by a hardware SPI select.
 *
 * The host therefore hands this model:
 *   - {@link onSignal} for every `DC` / `RST` / `BL` / `CS` edge, in the order
 *     the guest wrote them (a Unix socket preserves order), and
 *   - {@link onBus} for each SPI hardware transaction (one `SPI_CMD.USR`
 *     pulse), which it interprets against the *current* `DC` level.
 *
 * ADR 0001's load-bearing rule holds: `onBus` takes and returns a whole
 * buffer, and the framebuffer never travels in {@link snapshot} — the host
 * pulls it with {@link takeFrame} on a refresh-rate timer and sends it down a
 * side channel. `snapshot()` is scalars only.
 *
 * Fidelity is functional, not cycle-accurate (a v1 non-goal): the command set
 * is what an ST7789 panel driver actually issues, GRAM is the real 240×320
 * array, and `MADCTL` scan direction is applied on write. Gamma, porch and
 * VCOM commands are accepted and ignored.
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

/** ST7789 GRAM is physically 240 (columns) × 320 (rows), regardless of MADCTL. */
export const GRAM_W = 240
export const GRAM_H = 320

// Command opcodes the driver issues. Names from the ST7789V datasheet.
const CMD = {
  NOP: 0x00,
  SWRESET: 0x01,
  SLPIN: 0x10,
  SLPOUT: 0x11,
  PTLON: 0x12,
  NORON: 0x13,
  INVOFF: 0x20,
  INVON: 0x21,
  GAMSET: 0x26,
  DISPOFF: 0x28,
  DISPON: 0x29,
  CASET: 0x2a,
  RASET: 0x2b,
  RAMWR: 0x2c,
  RAMRD: 0x2e,
  PTLAR: 0x30,
  TEOFF: 0x34,
  TEON: 0x35,
  MADCTL: 0x36,
  IDMOFF: 0x38,
  IDMON: 0x39,
  COLMOD: 0x3a,
  RAMWRC: 0x3c
} as const

// MADCTL bits (0x36 parameter).
const MADCTL_MY = 0x80
const MADCTL_MX = 0x40
const MADCTL_MV = 0x20
const MADCTL_RGB = 0x08 // 0 = RGB, 1 = BGR

/** Commands that carry no parameters — seen once, acted on, done. */
const NO_PARAM = new Set<number>([
  CMD.NOP,
  CMD.SWRESET,
  CMD.SLPIN,
  CMD.SLPOUT,
  CMD.PTLON,
  CMD.NORON,
  CMD.INVOFF,
  CMD.INVON,
  CMD.DISPOFF,
  CMD.DISPON,
  CMD.TEOFF,
  CMD.IDMOFF,
  CMD.IDMON
])

/** Commands we accept and deliberately ignore the parameters of (porch, gamma, power, VCOM…). */
const IGNORED_WITH_PARAMS = new Set<number>([
  0x35, // TEON — one param (we treat TE as always-on regardless)
  0x26, // GAMSET
  0xb0,
  0xb1,
  0xb2,
  0xb3,
  0xb7, // RAM ctrl / frame rate / porch / gate
  0xbb,
  0xc0,
  0xc2,
  0xc3,
  0xc4,
  0xc6,
  0xd0,
  0xd6, // VCOM / power
  0xe0,
  0xe1,
  0xe4,
  0xe8,
  0xec,
  0xf0,
  0xf1,
  0xf2,
  0xf3,
  0xf4 // gamma / undocumented
])

export interface St7789Options {
  /**
   * `BL` line polarity. Default `true` (panel lit when `BL` high). The M9 wires
   * it active-low (`variant.h`'s `TFT_BACKLIGHT_ON LOW`), so its `u3` sets this
   * `false` via `PartDefinition.deviceOptions`.
   */
  backlightActiveHigh?: boolean
  /** `RST` line polarity — reset asserted when the line is low (datasheet). */
  resetActiveLow?: boolean
}

/**
 * What makes a sibling MIPI-DCS panel controller differ from the ST7789. The
 * GC9A01 speaks the same CASET/RASET/RAMWR/MADCTL/COLMOD core, so `gc9a01.ts`
 * is this class with a different GRAM, name and vendor-opcode set — not a copy.
 */
export interface PanelVariant {
  /** Device-model id the registry knows this panel by. */
  id: string
  /** Name used in diagnostics, e.g. `GC9A01`. */
  label: string
  /** Physical GRAM columns × rows, regardless of MADCTL. */
  gramWidth: number
  gramHeight: number
  /** Vendor opcodes whose parameters are accepted and dropped. */
  ignoredCommands?: Iterable<number>
  /**
   * The glass itself is normally-black: the panel shows true colour only under
   * INVON. Real IPS GC9A01 modules ship this way, so their drivers always send
   * `0x21`; the frame reports `inverted` as INVON XOR this.
   */
  nativeInversion?: boolean
}

const ST7789_VARIANT: PanelVariant = {
  id: 'sitronix.st7789',
  label: 'ST7789',
  gramWidth: GRAM_W,
  gramHeight: GRAM_H
}

export function st7789Options(raw?: Record<string, unknown>): St7789Options {
  const o: St7789Options = {}
  if (typeof raw?.['backlightActiveHigh'] === 'boolean') {
    o.backlightActiveHigh = raw['backlightActiveHigh']
  }
  if (typeof raw?.['resetActiveLow'] === 'boolean') o.resetActiveLow = raw['resetActiveLow']
  return o
}

/** A pending multi-byte command whose parameters have not all arrived yet. */
interface Pending {
  cmd: number
  params: number[]
  /** How many parameter bytes this command consumes before it is applied. */
  need: number
}

interface DirtyRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export class St7789Model implements DeviceModel {
  readonly id: string
  readonly meters: readonly MeterDeclaration[] = [
    { id: 'flush', label: 'Flush time', unit: 'ms' },
    { id: 'dirty', label: 'Dirty rects' },
    { id: 'txnPerFrame', label: 'Txns / frame' },
    { id: 'busShare', label: 'Bus share', unit: '%' }
  ]

  private readonly backlightActiveHigh: boolean
  private readonly resetActiveLow: boolean
  private readonly label: string
  private readonly gramW: number
  private readonly gramH: number
  private readonly ignored: ReadonlySet<number>
  private readonly nativeInversion: boolean
  private ctx: DeviceContext | null = null

  /** Physical GRAM (240×320 on the ST7789), RGB565. */
  private gram: Uint16Array

  // Line state, fed by onSignal. `dc` powers on LOW (command): every real
  // driver's first transfer is a command, and the fork's GPIO observer only
  // forwards *changes*, so an initial `digitalWrite(DC, LOW)` over a reset-0
  // register is never seen — starting HIGH mis-reads that first command as a
  // stray data byte.
  private dc: 0 | 1 = 0
  private csLow = false
  private rstAsserted = false
  /**
   * Set in the constructor from the polarity. `BL` idles low at power-on, and
   * the fork's GPIO observer forwards only *changes* — so an active-low panel
   * whose driver writes `BL` low anyway (the M9) would never get an edge and
   * must already read as lit.
   */
  private backlightOn = false

  // Controller state.
  private sleepOut = false
  private displayOn = false
  private inverted = false
  private bpp: 16 | 18 = 16
  private madctl = 0
  private caset: { xs: number; xe: number }
  private raset: { ys: number; ye: number }
  private pending: Pending | null = null
  /** RAMWR cursor. */
  private col = 0
  private row = 0
  /** Half of a 16bpp pixel held between transactions (driver may split a pixel). */
  private pixelHi = -1
  /** Leftover bytes of an 18bpp pixel held between transactions. */
  private rgb18: number[] = []

  // Metering / dirty tracking.
  private dirty: DirtyRect | null = null
  private frameDirty = false
  private resetCount = 0
  private frames = 0
  private ramwrBytes = 0
  private dirtyRectCount = 0
  /** ms the guest spent streaming pixels for the last completed frame. */
  private lastFlushMs = 0
  /**
   * Guest timestamp of the first `RAMWR` since the last {@link takeFrame}, and
   * of the most recent pixel byte. `takeFrame` turns the span between them into
   * {@link lastFlushMs}. `-1` = no RAMWR yet this frame. MeshCore's driver
   * issues one `RAMWR` *per row* (~240/frame), so this must span the whole
   * frame, not reset per RAMWR.
   */
  private frameFlushStartT = -1
  private lastPixelT = 0
  private txnsThisFrame = 0
  private txnsPerFrame = 0
  private bytesOnBus = 0

  constructor(options: St7789Options = {}, variant: PanelVariant = ST7789_VARIANT) {
    this.id = variant.id
    this.label = variant.label
    this.gramW = variant.gramWidth
    this.gramH = variant.gramHeight
    this.ignored = new Set([...IGNORED_WITH_PARAMS, ...(variant.ignoredCommands ?? [])])
    this.nativeInversion = variant.nativeInversion ?? false
    this.gram = new Uint16Array(this.gramW * this.gramH)
    this.caset = { xs: 0, xe: this.gramW - 1 }
    this.raset = { ys: 0, ye: this.gramH - 1 }
    this.backlightActiveHigh = options.backlightActiveHigh ?? true
    this.resetActiveLow = options.resetActiveLow ?? true
    this.backlightOn = !this.backlightActiveHigh
  }

  attach(ctx: DeviceContext): void {
    this.ctx = ctx
    this.powerOn()
  }

  reset(): void {
    this.powerOn()
    this.ctx?.emit({ kind: 'reset', summary: 'Panel reset' })
  }

  detach(): void {
    this.ctx = null
  }

  private powerOn(): void {
    this.gram = new Uint16Array(this.gramW * this.gramH)
    this.dc = 0
    this.csLow = false
    this.rstAsserted = false
    // BL idles low; lit at power-on iff the panel is active-low.
    this.backlightOn = !this.backlightActiveHigh
    this.sleepOut = false
    this.displayOn = false
    this.inverted = false
    this.bpp = 16
    this.madctl = 0
    this.caset = { xs: 0, xe: this.gramW - 1 }
    this.raset = { ys: 0, ye: this.gramH - 1 }
    this.pending = null
    this.col = 0
    this.row = 0
    this.pixelHi = -1
    this.rgb18 = []
    this.dirty = { x0: 0, y0: 0, x1: this.gramW - 1, y1: this.gramH - 1 }
    this.frameDirty = true
    this.ramwrBytes = 0
    this.txnsThisFrame = 0
    this.frameFlushStartT = -1
    this.lastPixelT = 0
  }

  // --- lines in ------------------------------------------------------------

  onSignal(edge: SignalEdge): void {
    switch (edge.signal) {
      case 'DC':
      case 'RS': // ST7789_RS in the M9 variant is the data/command line
        this.dc = edge.level
        return
      case 'CS':
        this.csLow = edge.level === 0
        return
      case 'BL':
      case 'BL_EN': {
        const on = this.backlightActiveHigh ? edge.level === 1 : edge.level === 0
        if (on !== this.backlightOn) {
          this.backlightOn = on
          this.ctx?.emit({ kind: 'backlight', summary: `Backlight ${on ? 'ON' : 'OFF'}` })
        }
        return
      }
      case 'RST':
      case 'RESET': {
        const asserted = this.resetActiveLow ? edge.level === 0 : edge.level === 1
        if (asserted && !this.rstAsserted) {
          this.rstAsserted = true
        } else if (!asserted && this.rstAsserted) {
          // Rising edge out of reset — the datasheet's hardware reset.
          this.rstAsserted = false
          this.resetCount += 1
          this.powerOn()
          this.ctx?.emit({ kind: 'reset', summary: 'Hardware reset (RST)' })
        }
        return
      }
      case 'SCK':
      case 'MOSI':
      case 'MISO':
        // Bus lines: the controller drives them, and their bytes arrive whole
        // through onBus. An edge here is just the driver enabling the pin
        // (IDF's spi_bus_initialize does), not something the panel acts on.
        return
      default:
        this.ctx?.diagnose('warn', `${this.label} has no line "${edge.signal}"`)
    }
  }

  // --- bus in ------------------------------------------------------------

  onBus(txn: BusTransaction): BusResponse {
    const miso = new Uint8Array(txn.mosi.length) // ST7789 MISO is not modelled; reads return 0
    this.bytesOnBus += txn.mosi.length
    this.txnsThisFrame += 1

    for (const byte of txn.mosi) {
      if (this.dc === 0) {
        // A command byte. Any half-consumed command is abandoned — the real
        // driver never interleaves, but be defensive rather than silent.
        this.beginCommand(byte, txn.t)
      } else {
        this.consumeData(byte, txn.t)
      }
    }
    return { miso }
  }

  private beginCommand(cmd: number, t: number): void {
    this.pending = null
    this.pixelHi = -1
    this.rgb18 = []

    if (cmd === CMD.RAMWR) {
      // Pixel stream follows (DC high). Reset the cursor to the window origin.
      this.col = this.caset.xs
      this.row = this.raset.ys
      if (this.frameFlushStartT < 0) this.frameFlushStartT = t
      this.pending = { cmd, params: [], need: Number.POSITIVE_INFINITY }
      return
    }
    if (cmd === CMD.RAMWRC) {
      // Continue writing at the current cursor.
      if (this.frameFlushStartT < 0) this.frameFlushStartT = t
      this.pending = { cmd, params: [], need: Number.POSITIVE_INFINITY }
      return
    }
    if (NO_PARAM.has(cmd)) {
      this.applyNoParam(cmd)
      return
    }
    if (cmd === CMD.CASET || cmd === CMD.RASET) {
      this.pending = { cmd, params: [], need: 4 }
      return
    }
    if (cmd === CMD.MADCTL || cmd === CMD.COLMOD || cmd === CMD.GAMSET) {
      this.pending = { cmd, params: [], need: 1 }
      return
    }
    if (cmd === CMD.PTLAR) {
      this.pending = { cmd, params: [], need: 4 }
      return
    }
    if (this.ignored.has(cmd)) {
      // Swallow its parameters without acting; length varies, so just drop
      // subsequent data bytes until the next command.
      this.pending = { cmd, params: [], need: Number.POSITIVE_INFINITY }
      return
    }
    this.ctx?.diagnose(
      'warn',
      `${this.label}: unimplemented command 0x${cmd.toString(16).padStart(2, '0')}`
    )
    this.pending = { cmd, params: [], need: Number.POSITIVE_INFINITY }
  }

  private consumeData(byte: number, t: number): void {
    const p = this.pending
    if (!p) {
      // Data with no command in flight — the driver sent parameters before any
      // command, or after a NO_PARAM command. Ignore, but say so once.
      this.ctx?.diagnose('info', `${this.label}: data byte with no command context`)
      return
    }
    if (p.cmd === CMD.RAMWR || p.cmd === CMD.RAMWRC) {
      this.writePixelByte(byte, t)
      return
    }
    if (p.need === Number.POSITIVE_INFINITY) return // ignored-params command

    p.params.push(byte)
    if (p.params.length < p.need) return
    this.applyWithParams(p)
    this.pending = null
  }

  private applyNoParam(cmd: number): void {
    switch (cmd) {
      case CMD.SWRESET:
        this.resetCount += 1
        this.powerOn()
        this.ctx?.emit({ kind: 'reset', summary: 'Software reset (SWRESET)' })
        break
      case CMD.SLPOUT:
        this.sleepOut = true
        this.ctx?.emit({ kind: 'cmd', summary: 'Sleep out' })
        break
      case CMD.SLPIN:
        this.sleepOut = false
        break
      case CMD.NORON:
        break
      case CMD.INVON:
        this.inverted = true
        this.markAllDirty()
        break
      case CMD.INVOFF:
        this.inverted = false
        this.markAllDirty()
        break
      case CMD.DISPON:
        this.displayOn = true
        this.markAllDirty()
        this.ctx?.emit({ kind: 'cmd', summary: 'Display ON' })
        break
      case CMD.DISPOFF:
        this.displayOn = false
        this.markAllDirty()
        break
      default:
        break
    }
  }

  private applyWithParams(p: Pending): void {
    switch (p.cmd) {
      case CMD.CASET: {
        const xs = (p.params[0]! << 8) | p.params[1]!
        const xe = (p.params[2]! << 8) | p.params[3]!
        // With MV the column-address axis is the 320-long one (landscape): a
        // driver addressing 0..319 here — as MeshCore's per-row setAddrWindow
        // does — is in range, not something to clamp down to 239.
        const max = this.madctl & MADCTL_MV ? this.gramH - 1 : this.gramW - 1
        this.caset = { xs: clamp(xs, 0, max), xe: clamp(xe, 0, max) }
        break
      }
      case CMD.RASET: {
        const ys = (p.params[0]! << 8) | p.params[1]!
        const ye = (p.params[2]! << 8) | p.params[3]!
        const max = this.madctl & MADCTL_MV ? this.gramW - 1 : this.gramH - 1
        this.raset = { ys: clamp(ys, 0, max), ye: clamp(ye, 0, max) }
        break
      }
      case CMD.MADCTL:
        this.madctl = p.params[0]!
        this.markAllDirty()
        this.ctx?.emit({
          kind: 'cmd',
          summary: `MADCTL 0x${this.madctl.toString(16)}`,
          detail: {
            MY: !!(this.madctl & MADCTL_MY),
            MX: !!(this.madctl & MADCTL_MX),
            MV: !!(this.madctl & MADCTL_MV),
            BGR: !!(this.madctl & MADCTL_RGB)
          }
        })
        break
      case CMD.COLMOD: {
        const mode = p.params[0]! & 0x07
        this.bpp = mode === 0x06 ? 18 : 16
        this.ctx?.emit({ kind: 'cmd', summary: `COLMOD ${this.bpp}bpp` })
        break
      }
      case CMD.GAMSET:
      case CMD.PTLAR:
        break
      default:
        break
    }
  }

  // --- RAMWR ------------------------------------------------------------

  private writePixelByte(byte: number, t: number): void {
    this.ramwrBytes += 1
    if (this.bpp === 16) {
      if (this.pixelHi < 0) {
        this.pixelHi = byte
        return
      }
      const rgb565 = ((this.pixelHi << 8) | byte) & 0xffff
      this.pixelHi = -1
      this.putPixel(rgb565)
    } else {
      this.rgb18.push(byte)
      if (this.rgb18.length < 3) return
      const r = this.rgb18[0]! >> 3
      const g = this.rgb18[1]! >> 2
      const b = this.rgb18[2]! >> 3
      this.rgb18 = []
      this.putPixel(((r << 11) | (g << 5) | b) & 0xffff)
    }
    this.lastPixelT = t
  }

  /**
   * Write one pixel at the RAMWR cursor and advance it. The ST7789's address
   * counter always advances the column address first, wrapping to the next row
   * address at the end of the CASET window — MV does **not** change that. What
   * MV changes is the *physical* cell: with MV the column address walks GRAM's
   * 320-long axis and the row address its 240-long axis (the panel is
   * transposed). MX / MY mirror each address within its window.
   */
  private putPixel(rgb565: number): void {
    const mv = !!(this.madctl & MADCTL_MV)
    const mx = !!(this.madctl & MADCTL_MX)
    const my = !!(this.madctl & MADCTL_MY)

    const ca = mx ? this.caset.xe - (this.col - this.caset.xs) : this.col
    const ra = my ? this.raset.ye - (this.row - this.raset.ys) : this.row
    const physX = mv ? ra : ca
    const physY = mv ? ca : ra
    if (physX >= 0 && physX < this.gramW && physY >= 0 && physY < this.gramH) {
      this.gram[physY * this.gramW + physX] = rgb565
      this.growDirty(physX, physY)
    }

    this.col += 1
    if (this.col > this.caset.xe) {
      this.col = this.caset.xs
      this.row += 1
      if (this.row > this.raset.ye) this.row = this.raset.ys
    }
  }

  private growDirty(x: number, y: number): void {
    this.frameDirty = true
    if (!this.dirty) {
      this.dirty = { x0: x, y0: y, x1: x, y1: y }
      this.dirtyRectCount += 1
      return
    }
    if (x < this.dirty.x0) this.dirty.x0 = x
    if (y < this.dirty.y0) this.dirty.y0 = y
    if (x > this.dirty.x1) this.dirty.x1 = x
    if (y > this.dirty.y1) this.dirty.y1 = y
  }

  private markAllDirty(): void {
    this.dirty = { x0: 0, y0: 0, x1: this.gramW - 1, y1: this.gramH - 1 }
    this.frameDirty = true
    this.dirtyRectCount += 1
  }

  // --- frame side channel (host pulls this on a refresh timer) ------------

  /** True when GRAM changed since the last {@link takeFrame}. */
  get hasFrame(): boolean {
    return this.frameDirty
  }

  /**
   * Hand the host the current GRAM plus the metadata it needs to present it.
   * Clears the dirty state and closes the per-frame transaction count. Returns
   * `null` if nothing changed. The pixel buffer is a copy — the model keeps
   * mutating its own.
   */
  takeFrame(): {
    width: number
    height: number
    madctl: number
    displayOn: boolean
    backlightOn: boolean
    /** INVON is applied at scan-out on real hardware — the renderer inverts. */
    inverted: boolean
    dirty: { x: number; y: number; w: number; h: number }
    pixels: Uint16Array
  } | null {
    if (!this.frameDirty || !this.dirty) return null
    const d = this.dirty
    const frame = {
      width: this.gramW,
      height: this.gramH,
      madctl: this.madctl,
      displayOn: this.displayOn && this.sleepOut,
      backlightOn: this.backlightOn,
      inverted: this.inverted !== this.nativeInversion,
      dirty: { x: d.x0, y: d.y0, w: d.x1 - d.x0 + 1, h: d.y1 - d.y0 + 1 },
      pixels: this.gram.slice()
    }
    this.frameDirty = false
    this.dirty = null
    this.frames += 1
    this.txnsPerFrame = this.txnsThisFrame
    this.txnsThisFrame = 0
    if (this.frameFlushStartT >= 0) {
      // Whole-frame pixel-streaming span, ms with 2 decimals.
      this.lastFlushMs = Math.max(
        0,
        Math.round((this.lastPixelT - this.frameFlushStartT) / 1e4) / 100
      )
      this.frameFlushStartT = -1
    }
    return frame
  }

  // --- observable state -------------------------------------------------

  snapshot(): DeviceSnapshot {
    return {
      // Deliberately scalars only — the framebuffer goes down the side channel.
      poweredOn: this.sleepOut,
      displayOn: this.displayOn,
      backlightOn: this.backlightOn,
      inverted: this.inverted,
      bpp: this.bpp,
      madctl: this.madctl,
      window: {
        x: this.caset.xs,
        y: this.raset.ys,
        w: this.caset.xe - this.caset.xs + 1,
        h: this.raset.ye - this.raset.ys + 1
      },
      ramwrBytes: this.ramwrBytes,
      frames: this.frames,
      resetCount: this.resetCount,
      dc: this.dc,
      csLow: this.csLow
    }
  }

  meter(id: string): number | undefined {
    switch (id) {
      case 'flush':
        return this.lastFlushMs
      case 'dirty':
        return this.dirtyRectCount
      case 'txnPerFrame':
        return this.txnsPerFrame
      case 'busShare': {
        if (this.bytesOnBus <= 0) return 0
        // Filled in by the host, which knows the whole-bus total; on its own
        // the model reports 100 (it is the only traffic it sees).
        return 100
      }
      default:
        return undefined
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export const st7789Descriptor: DeviceModelDescriptor = {
  id: 'sitronix.st7789',
  summary:
    'ST7789 320×240 SPI panel. Command state machine, CASET/RASET/RAMWR, MADCTL scan order, 16/18bpp, DC/RST/BL lines; framebuffer to the OUT panel.',
  create: (options) => new St7789Model(st7789Options(options))
}
