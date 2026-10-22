/**
 * UltraChip UC8151 — the controller behind the Heltec Wireless Paper v1.1's
 * 2.13" 128×250 monochrome e-paper panel (roadmap M13). MeshCore's
 * `E213Display` reaches it through `heltec-eink-modules`, whose
 * `EInkDisplay_WirelessPaperV1_1` alias resolves to the library's
 * `LCMEN2R13EFC1` driver (connector HINK-E0213A162) — a UC8151-class part, *not*
 * the SSD1680 that the earlier Wireless Paper V1 panel used. The command sets
 * have almost nothing in common, so this is a distinct model.
 *
 * ## Shape of the traffic — read from the driver, not a datasheet guess
 *
 * `LCMEN2R13EFC1` (`.pio/libdeps/.../heltec-eink-modules/src/Displays/LCMEN2R13EFC1/`)
 * talks UC8151 over the private `spi-disp` bus (SCLK GPIO3, MOSI GPIO2, no
 * MISO), toggling `DC` low for a command byte and high for its data — the same
 * `DC` discipline as the ST7789. `CS` is a plain GPIO the host tracks from
 * {@link onSignal}. `BUSY` on this controller is **active-low** — the driver's
 * `wait()` loops `while(digitalRead(pin_busy) == LOW)`, and its own comment
 * notes this is "different than the SSD display controllers".
 *
 *   - **Config**: `PSR` (0x00, panel setting — bit 5 selects the register LUT,
 *     i.e. partial/fast mode, over the OTP LUT), `CDI` (0x50, VCOM/data
 *     interval). `configFull()` and `configPartial()` differ only in the PSR
 *     bit and whether the five LUTs are loaded.
 *   - **LUTs**: `LUT_VCOM` (0x20), `LUT_WW` (0x21), `LUT_BW` (0x22),
 *     `LUT_WB` (0x23), `LUT_BB` (0x24) — 56 data bytes each; the driver only
 *     sends them for a partial refresh (`fastmodeOn()`), so their presence is
 *     the partial-mode signal.
 *   - **Image**: `DTM1` (0x10, "OLD/BW" plane) and `DTM2` (0x13, "NEW" plane),
 *     each followed by `128 * 250 / 8` = 4000 bytes; bit set = white (the
 *     driver blanks with `(default_color & WHITE) * 255`). A full refresh
 *     writes both planes the same; fast mode writes NEW then, on a second pass,
 *     OLD.
 *   - **Update**: `activate()` is `PON` (0x04) → wait → `DRF` (0x12) → wait →
 *     `POF` (0x02). The panel image latches — and `BUSY` asserts for the
 *     refresh — on `DRF`.
 *
 * ADR 0001 holds: `onBus` takes and returns a whole buffer; the framebuffer is
 * pulled by {@link takeFrame} on a timer and sent as a packed 1bpp buffer
 * (`format: 'mono1'`), never in {@link snapshot}. Fidelity is functional: the
 * refresh *duration* is a meter and an event, and `BUSY` is pulsed around the
 * synchronous `DRF` rather than held for wall-clock time — the guest polls it
 * after the transaction returns and sees it released (the "always ready when
 * asked" shape the LR1110 uses for its own `BUSY`). Unknown opcodes raise a
 * loud named diagnostic (M7's rule).
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

/** Panel geometry — 128 wide × 250 tall (native, portrait); 122×250 usable. */
export const PANEL_W = 128
export const PANEL_H = 250
export const BYTES_PER_ROW = PANEL_W / 8 // 16
export const PLANE_BYTES = BYTES_PER_ROW * PANEL_H // 4000

// UC8151 command opcodes (from the LCMEN2R13EFC1 driver).
const CMD = {
  PSR: 0x00, // panel setting
  PWR: 0x01, // power setting
  POF: 0x02, // power OFF
  PON: 0x04, // power ON
  BTST: 0x06, // booster soft start
  DSLP: 0x07, // deep sleep
  DTM1: 0x10, // data start transmission 1 (OLD / B-W plane)
  DSP: 0x11, // data stop
  DRF: 0x12, // display refresh
  DTM2: 0x13, // data start transmission 2 (NEW plane)
  LUT_VCOM: 0x20,
  LUT_WW: 0x21,
  LUT_BW: 0x22,
  LUT_WB: 0x23,
  LUT_BB: 0x24,
  PLL: 0x30,
  TSE: 0x41, // temperature sensor
  CDI: 0x50, // VCOM and data interval
  TCON: 0x60,
  TRES: 0x61, // resolution setting
  VDCS: 0x82, // VCOM DC setting
  PTL: 0x90, // partial window
  PTIN: 0x91, // partial in
  PTOUT: 0x92 // partial out
} as const

/** Config / setup commands whose parameters we accept and ignore. */
const IGNORED_WITH_PARAMS = new Set<number>([
  CMD.PWR,
  CMD.BTST,
  CMD.DSP,
  CMD.PLL,
  CMD.TSE,
  CMD.TCON,
  CMD.TRES,
  CMD.VDCS,
  CMD.PTL
])
/** Commands the LUT registers use — 56 data bytes, swallowed. */
const LUT_CMDS = new Set<number>([CMD.LUT_VCOM, CMD.LUT_WW, CMD.LUT_BW, CMD.LUT_WB, CMD.LUT_BB])

/** Modelled panel redraw time, ms — UC8151 2.13" ballpark. */
const REFRESH_MS = { full: 2000, partial: 480 } as const
type RefreshKind = keyof typeof REFRESH_MS

export interface Uc8151Options {
  /**
   * `BUSY` polarity. The UC8151 signals busy **LOW** (default `true`), unlike
   * the SSD-family controllers — the board's `deviceOptions` records this.
   */
  busyActiveLow?: boolean
}

function uc8151Options(raw?: Record<string, unknown>): Uc8151Options {
  const o: Uc8151Options = {}
  if (typeof raw?.['busyActiveLow'] === 'boolean') o.busyActiveLow = raw['busyActiveLow']
  return o
}

interface Pending {
  cmd: number
  params: number[]
  /** Params to collect before applying; `Infinity` = swallow until next command. */
  need: number
}

export class Uc8151Model implements DeviceModel {
  readonly id = 'ultrachip.uc8151'
  /** BUSY (GPIO7) is an input the SoC level-polls during a refresh. */
  readonly outputSignals = ['BUSY'] as const
  readonly meters: readonly MeterDeclaration[] = [
    { id: 'refreshMs', label: 'Last refresh', unit: 'ms' },
    { id: 'refreshes', label: 'Refreshes' },
    { id: 'partialShare', label: 'Partial refreshes', unit: '%' },
    { id: 'busShare', label: 'Bus share', unit: '%' }
  ]

  private readonly busyActiveLow: boolean
  private ctx: DeviceContext | null = null

  // Line state.
  private dc: 0 | 1 = 0
  private csLow = false
  private rstAsserted = false

  // Controller RAM — packed 1bpp, bit set = white. Two planes (OLD/NEW).
  private planeOld = new Uint8Array(PLANE_BYTES).fill(0xff)
  private planeNew = new Uint8Array(PLANE_BYTES).fill(0xff)
  /** What the panel is currently showing — latched on DRF. */
  private visible = new Uint8Array(PLANE_BYTES).fill(0xff)

  // Update state.
  private pending: Pending | null = null
  private imageTarget: 'old' | 'new' | null = null
  private imageCursor = 0
  private customLut = false
  private psr = 0
  private poweredOn = false

  // Metering / dirty tracking.
  private frameDirty = false
  private refreshCount = 0
  private partialCount = 0
  private lastRefreshMs = 0
  private lastRefresh: RefreshKind = 'full'
  private resetCount = 0
  private bytesOnBus = 0

  constructor(options: Uc8151Options = {}) {
    this.busyActiveLow = options.busyActiveLow ?? true
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
    this.dc = 0
    this.csLow = false
    this.rstAsserted = false
    this.planeOld = new Uint8Array(PLANE_BYTES).fill(0xff)
    this.planeNew = new Uint8Array(PLANE_BYTES).fill(0xff)
    this.visible = new Uint8Array(PLANE_BYTES).fill(0xff)
    this.pending = null
    this.imageTarget = null
    this.imageCursor = 0
    this.customLut = false
    this.psr = 0
    this.poweredOn = false
    this.frameDirty = true
    this.ctx?.driveSignal('BUSY', this.busyLevel(false))
  }

  private busyLevel(busy: boolean): 0 | 1 {
    // Active-low: pin LOW == busy.
    return (busy === this.busyActiveLow ? 0 : 1) as 0 | 1
  }

  // --- lines in --------------------------------------------------------

  onSignal(edge: SignalEdge): void {
    switch (edge.signal) {
      case 'DC':
      case 'RS':
        this.dc = edge.level
        return
      case 'CS':
        this.csLow = edge.level === 0
        return
      case 'RST':
      case 'RESET': {
        const asserted = edge.level === 0 // active-low
        if (asserted && !this.rstAsserted) {
          this.rstAsserted = true
          // Holding RST asserted holds the panel busy — real hardware, and what
          // `E213Display::detectEInk()` relies on: it pulls RST low and reads
          // BUSY, choosing the `LCMEN2R13EFC1` (UC8151) driver iff BUSY reads
          // the busy level. Not driving it here would leave the idle level and
          // steer the guest to the *other* driver, whose command set we do not
          // model.
          this.ctx?.driveSignal('BUSY', this.busyLevel(true))
        } else if (!asserted && this.rstAsserted) {
          this.rstAsserted = false
          this.resetCount += 1
          this.powerOn()
          this.ctx?.emit({ kind: 'reset', summary: 'Hardware reset (RST)' })
        }
        return
      }
      default:
        this.ctx?.diagnose('warn', `UC8151 has no input line "${edge.signal}"`)
    }
  }

  // --- bus in ---------------------------------------------------------

  onBus(txn: BusTransaction): BusResponse {
    const miso = new Uint8Array(txn.mosi.length) // no MISO on the e-ink bus
    this.bytesOnBus += txn.mosi.length
    for (const byte of txn.mosi) {
      if (this.dc === 0) this.beginCommand(byte)
      else this.consumeData(byte)
    }
    return { miso }
  }

  private beginCommand(cmd: number): void {
    this.pending = null
    this.imageTarget = null

    switch (cmd) {
      case CMD.PSR:
        this.pending = { cmd, params: [], need: 1 }
        return
      case CMD.CDI:
        this.pending = { cmd, params: [], need: 1 }
        return
      case CMD.PON:
        this.poweredOn = true
        this.pulseBusy()
        return
      case CMD.POF:
        this.poweredOn = false
        return
      case CMD.DRF:
        this.runRefresh()
        return
      case CMD.DSLP:
        this.pending = { cmd, params: [], need: 1 }
        return
      case CMD.DTM1:
        this.imageTarget = 'old'
        this.imageCursor = 0
        this.pending = { cmd, params: [], need: Number.POSITIVE_INFINITY }
        return
      case CMD.DTM2:
        this.imageTarget = 'new'
        this.imageCursor = 0
        this.pending = { cmd, params: [], need: Number.POSITIVE_INFINITY }
        return
    }

    if (LUT_CMDS.has(cmd)) {
      this.customLut = true
      this.pending = { cmd, params: [], need: Number.POSITIVE_INFINITY }
      if (cmd === CMD.LUT_VCOM) {
        this.ctx?.emit({ kind: 'cmd', summary: 'Custom LUTs loaded (fast/partial mode)' })
      }
      return
    }
    if (IGNORED_WITH_PARAMS.has(cmd)) {
      this.pending = { cmd, params: [], need: Number.POSITIVE_INFINITY }
      return
    }
    if (cmd === CMD.PTIN || cmd === CMD.PTOUT) return // partial in/out — no params

    this.ctx?.diagnose(
      'warn',
      `UC8151: unimplemented command 0x${cmd.toString(16).padStart(2, '0')}`
    )
    this.pending = { cmd, params: [], need: Number.POSITIVE_INFINITY }
  }

  private consumeData(byte: number): void {
    const p = this.pending
    if (!p) {
      this.ctx?.diagnose('info', 'UC8151: data byte with no command context')
      return
    }
    if (p.cmd === CMD.DTM1 || p.cmd === CMD.DTM2) {
      const plane = this.imageTarget === 'old' ? this.planeOld : this.planeNew
      if (this.imageCursor < plane.length) plane[this.imageCursor] = byte
      this.imageCursor += 1
      return
    }
    if (p.need === Number.POSITIVE_INFINITY) return // LUT / ignored-params
    p.params.push(byte)
    if (p.params.length < p.need) return
    this.applyWithParams(p)
    this.pending = null
  }

  private applyWithParams(p: Pending): void {
    switch (p.cmd) {
      case CMD.PSR:
        this.psr = p.params[0]!
        // PSR bit 5 = use register LUT (partial); clear = OTP LUT (full).
        if ((this.psr & 0x20) === 0) this.customLut = false
        break
      case CMD.CDI:
      case CMD.DSLP:
        break
    }
  }

  private runRefresh(): void {
    const kind: RefreshKind = this.customLut || (this.psr & 0x20) !== 0 ? 'partial' : 'full'
    this.lastRefresh = kind
    this.lastRefreshMs = REFRESH_MS[kind]
    this.refreshCount += 1
    if (kind === 'partial') this.partialCount += 1

    // The NEW plane is what the panel draws; a full refresh has written it (and
    // OLD) identically, a fast pass has written NEW alone. Keep OLD as the
    // now-previous frame for a differential update trace.
    this.planeOld.set(this.visible)
    this.visible.set(this.planeNew)
    this.frameDirty = true

    this.pulseBusy()
    this.ctx?.emit({
      kind: 'refresh',
      summary: `${kind} refresh, ${this.lastRefreshMs} ms`,
      detail: { kind, ms: this.lastRefreshMs, psr: `0x${this.psr.toString(16)}` }
    })
  }

  /**
   * Drive `BUSY` asserted then released around the operation. The guest polls
   * the line after this transaction returns, so it reads "released" and
   * proceeds — the latency is observable as the meter/event, not a wall-clock
   * stall (a v1 non-goal, as with the LR1110's `BUSY`).
   */
  private pulseBusy(): void {
    this.ctx?.driveSignal('BUSY', this.busyLevel(true))
    this.ctx?.driveSignal('BUSY', this.busyLevel(false))
  }

  // --- frame side channel --------------------------------------------

  get hasFrame(): boolean {
    return this.frameDirty
  }

  takeFrame(): {
    width: number
    height: number
    madctl: number
    displayOn: boolean
    backlightOn: boolean
    inverted: boolean
    format: 'mono1'
    dirty: { x: number; y: number; w: number; h: number }
    pixels: Uint8Array
  } | null {
    if (!this.frameDirty) return null
    const frame = {
      width: PANEL_W,
      height: PANEL_H,
      madctl: 0,
      displayOn: true,
      backlightOn: true, // e-ink is reflective; no backlight
      inverted: false,
      format: 'mono1' as const,
      dirty: { x: 0, y: 0, w: PANEL_W, h: PANEL_H },
      pixels: this.visible.slice()
    }
    this.frameDirty = false
    return frame
  }

  // --- observable state --------------------------------------------

  snapshot(): DeviceSnapshot {
    return {
      panel: `${PANEL_W}×${PANEL_H} mono e-ink (UC8151)`,
      lastRefresh: this.lastRefresh,
      lastRefreshMs: this.lastRefreshMs,
      refreshes: this.refreshCount,
      partialRefreshes: this.partialCount,
      customLut: this.customLut,
      poweredOn: this.poweredOn,
      psr: this.psr,
      resetCount: this.resetCount,
      dc: this.dc,
      csLow: this.csLow
    }
  }

  meter(id: string): number | undefined {
    switch (id) {
      case 'refreshMs':
        return this.lastRefreshMs
      case 'refreshes':
        return this.refreshCount
      case 'partialShare':
        return this.refreshCount > 0 ? Math.round((this.partialCount / this.refreshCount) * 100) : 0
      case 'busShare':
        return this.bytesOnBus > 0 ? 100 : 0
      default:
        return undefined
    }
  }
}

export const uc8151Descriptor: DeviceModelDescriptor = {
  id: 'ultrachip.uc8151',
  summary:
    'UC8151 128×250 monochrome e-paper (Heltec Wireless Paper v1.1, heltec-eink-modules LCMEN2R13EFC1). PSR/CDI config, LUT registers, DTM1/DTM2 planes, PON/DRF/POF update, active-low BUSY, full/partial refresh-time meter; pixels latch on DRF. Unimplemented opcodes raise a named diagnostic.',
  create: (options) => new Uc8151Model(uc8151Options(options))
}
