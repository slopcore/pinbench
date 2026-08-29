/**
 * Solomon Systech SSD1680 — the controller behind the Heltec Wireless Paper
 * v1.1's 2.13" 250×122 monochrome e-paper panel (roadmap M13). This is a
 * deliberately *different display class* from the ST7789: the guest writes a
 * whole frame into controller RAM and then issues one update command, the panel
 * takes hundreds of milliseconds to seconds to redraw, and it holds a `BUSY`
 * line the whole time — MeshCore blocks in `display.begin()` waiting on exactly
 * that line (ADR 0001, §"What else the spike found").
 *
 * ## Shape of the traffic
 *
 * MeshCore drives the panel through `heltec-eink-modules`
 * (`EInkDisplay_WirelessPaperV1_1`), which talks SSD1680 over a private SPI bus
 * (`spi-disp`: SCLK GPIO3, MOSI GPIO2, no MISO — the panel is write-only). The
 * driver toggles `DC` around each group exactly like the ST7789: `DC` low for a
 * command byte, `DC` high for its parameters and for RAM data. `CS` (GPIO4) is
 * a plain GPIO the driver drives with `digitalWrite`, so the host tracks
 * selection from {@link onSignal} edges, not a hardware select.
 *
 * The command set is the subset the driver actually issues:
 *
 *   - **Reset / power**: `SW_RESET` (0x12), `DEEP_SLEEP` (0x10). `SW_RESET`
 *     pulses `BUSY`.
 *   - **Panel setup**: `DRIVER_OUTPUT_CONTROL` (0x01, gives the gate count →
 *     height), `DATA_ENTRY_MODE` (0x11), `BORDER_WAVEFORM` (0x3C),
 *     `TEMP_SENSOR_CONTROL` (0x18), `DISPLAY_UPDATE_CONTROL_1` (0x21) — parsed
 *     where it matters, accepted and ignored otherwise.
 *   - **RAM window**: `SET_RAM_X` (0x44) / `SET_RAM_Y` (0x45) set the byte/row
 *     bounds; `SET_RAM_X_COUNTER` (0x4E) / `SET_RAM_Y_COUNTER` (0x4F) seat the
 *     write cursor.
 *   - **RAM write**: `WRITE_RAM_BW` (0x24) streams the black/white plane;
 *     `WRITE_RAM_RED` (0x26) streams the second plane, which this mono panel
 *     uses as the previous-frame reference for a partial refresh.
 *   - **Refresh**: `LOAD_LUT` / `WRITE_LUT` (0x32) selects a waveform (a custom
 *     LUT is the driver's "fast mode"); `DISPLAY_UPDATE_CONTROL_2` (0x22) arms
 *     an update sequence; `MASTER_ACTIVATION` (0x20) runs it — and *that* is
 *     when RAM becomes visible pixels and `BUSY` asserts for the refresh.
 *
 * ADR 0001's rule holds: `onBus` takes and returns a whole buffer, and the
 * framebuffer never rides in {@link snapshot} — the host pulls it with
 * {@link takeFrame} on a timer and sends it down the side channel as a packed
 * 1bpp buffer (`format: 'mono1'`). Fidelity is functional, not cycle-accurate:
 * the refresh *duration* is reported as a meter and an event, and `BUSY` is
 * pulsed around the (synchronous) update rather than held for real wall-clock
 * time — the guest polls `BUSY` after the SPI transaction returns and sees it
 * released, the same "always ready when asked" shape the LR1110 model uses for
 * its own `BUSY`. Unknown opcodes raise a loud named diagnostic (M7's rule).
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

/** Panel geometry — 250 wide × 122 tall, landscape. */
export const PANEL_W = 250
export const PANEL_H = 122
/** Packed 1bpp: whole bytes per row along the width. */
export const BYTES_PER_ROW = Math.ceil(PANEL_W / 8)

// SSD1680 command opcodes (datasheet §Command Table).
const CMD = {
  DRIVER_OUTPUT_CONTROL: 0x01,
  GATE_DRIVING_VOLTAGE: 0x03,
  SOURCE_DRIVING_VOLTAGE: 0x04,
  BOOSTER_SOFT_START: 0x0c,
  DEEP_SLEEP: 0x10,
  DATA_ENTRY_MODE: 0x11,
  SW_RESET: 0x12,
  TEMP_SENSOR_CONTROL: 0x18,
  TEMP_SENSOR_WRITE: 0x1a,
  MASTER_ACTIVATION: 0x20,
  DISPLAY_UPDATE_CONTROL_1: 0x21,
  DISPLAY_UPDATE_CONTROL_2: 0x22,
  WRITE_RAM_BW: 0x24,
  WRITE_RAM_RED: 0x26,
  WRITE_VCOM: 0x2c,
  WRITE_LUT: 0x32,
  SET_DISPLAY_OPTION: 0x37,
  BORDER_WAVEFORM: 0x3c,
  END_OPTION: 0x3f,
  SET_RAM_X: 0x44,
  SET_RAM_Y: 0x45,
  SET_RAM_X_COUNTER: 0x4e,
  SET_RAM_Y_COUNTER: 0x4f,
  NOP: 0x7f
} as const

/** Commands whose parameters we deliberately accept and ignore. */
const IGNORED_WITH_PARAMS = new Set<number>([
  CMD.GATE_DRIVING_VOLTAGE,
  CMD.SOURCE_DRIVING_VOLTAGE,
  CMD.BOOSTER_SOFT_START,
  CMD.TEMP_SENSOR_CONTROL,
  CMD.TEMP_SENSOR_WRITE,
  CMD.DISPLAY_UPDATE_CONTROL_1,
  CMD.WRITE_VCOM,
  CMD.SET_DISPLAY_OPTION,
  CMD.END_OPTION
])

/** DISPLAY_UPDATE_CONTROL_2 (0x22) sequence bytes → refresh kind. */
type RefreshKind = 'full' | 'fast' | 'partial'
function refreshKindFor(seq: number, customLut: boolean): RefreshKind {
  // 0xF7 / 0xC7 run the built-in OTP full-update waveform; 0xFF / 0xCF / 0xF4
  // run a loaded LUT, which the driver only loads for fast / partial updates.
  if (seq === 0xf7 || seq === 0xc7) return 'full'
  return customLut ? 'partial' : 'fast'
}

/** Modelled panel redraw time, milliseconds (Heltec WP V1.1 datasheet ballpark). */
const REFRESH_MS: Record<RefreshKind, number> = { full: 2600, fast: 900, partial: 340 }

export interface Ssd1680Options {
  /**
   * `BUSY` line polarity. The Heltec Wireless Paper V1.1 panel's Solomon Systech
   * controller signals busy **HIGH** (default `true`); a Fitipower-controller
   * revision signals busy LOW, which the board's `deviceOptions` would set.
   */
  busyActiveHigh?: boolean
}

function ssd1680Options(raw?: Record<string, unknown>): Ssd1680Options {
  const o: Ssd1680Options = {}
  if (typeof raw?.['busyActiveHigh'] === 'boolean') o.busyActiveHigh = raw['busyActiveHigh']
  return o
}

interface Pending {
  cmd: number
  params: number[]
  /** Parameter bytes to collect before applying; `Infinity` = swallow until next command. */
  need: number
}

interface DirtyRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export class Ssd1680Model implements DeviceModel {
  readonly id = 'sitronix.ssd1680'
  /** BUSY (GPIO7) is an input the SoC level-polls during a refresh. */
  readonly outputSignals = ['BUSY'] as const
  readonly meters: readonly MeterDeclaration[] = [
    { id: 'refreshMs', label: 'Last refresh', unit: 'ms' },
    { id: 'refreshes', label: 'Refreshes' },
    { id: 'partialShare', label: 'Partial refreshes', unit: '%' },
    { id: 'busShare', label: 'Bus share', unit: '%' }
  ]

  private readonly busyActiveHigh: boolean
  private ctx: DeviceContext | null = null

  // Line state.
  private dc: 0 | 1 = 0
  private csLow = false
  private rstAsserted = false

  // Controller RAM — packed 1bpp, bit set = white (SSD1680 BW plane convention).
  private ramBw = new Uint8Array(BYTES_PER_ROW * PANEL_H).fill(0xff)
  private ramRed = new Uint8Array(BYTES_PER_ROW * PANEL_H).fill(0xff)
  /** The last frame latched to the panel — what the OUT panel shows. */
  private visible = new Uint8Array(BYTES_PER_ROW * PANEL_H).fill(0xff)

  // RAM window + cursor, in the SSD1680's byte(x)/row(y) units.
  private xStartByte = 0
  private xEndByte = BYTES_PER_ROW - 1
  private yStart = 0
  private yEnd = PANEL_H - 1
  private xByte = 0
  private y = 0
  /** Data-entry mode 0x11 low bits: bit0 Y dir (0=dec,1=inc), bit1 X dir, bit2 first-axis. */
  private entryMode = 0x03

  // Update state.
  private pending: Pending | null = null
  private writeTarget: 'bw' | 'red' | null = null
  private updateSeq = 0xf7
  private customLut = false
  private deepSleep = false
  private lastRefresh: RefreshKind = 'full'

  // Metering / dirty tracking.
  private dirty: DirtyRect | null = null
  private frameDirty = false
  private refreshCount = 0
  private partialCount = 0
  private lastRefreshMs = 0
  private resetCount = 0
  private bytesOnBus = 0

  constructor(options: Ssd1680Options = {}) {
    this.busyActiveHigh = options.busyActiveHigh ?? true
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
    this.ramBw = new Uint8Array(BYTES_PER_ROW * PANEL_H).fill(0xff)
    this.ramRed = new Uint8Array(BYTES_PER_ROW * PANEL_H).fill(0xff)
    this.visible = new Uint8Array(BYTES_PER_ROW * PANEL_H).fill(0xff)
    this.xStartByte = 0
    this.xEndByte = BYTES_PER_ROW - 1
    this.yStart = 0
    this.yEnd = PANEL_H - 1
    this.xByte = 0
    this.y = 0
    this.entryMode = 0x03
    this.pending = null
    this.writeTarget = null
    this.updateSeq = 0xf7
    this.customLut = false
    this.deepSleep = false
    this.dirty = { x0: 0, y0: 0, x1: PANEL_W - 1, y1: PANEL_H - 1 }
    this.frameDirty = true
    // BUSY idle = not busy.
    this.ctx?.driveSignal('BUSY', this.busyLevel(false))
  }

  private busyLevel(busy: boolean): 0 | 1 {
    return (busy === this.busyActiveHigh ? 1 : 0) as 0 | 1
  }

  // --- lines in ----------------------------------------------------------

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
        // SSD1680 RST is active-low: level 0 asserts, the rising edge releases.
        const asserted = edge.level === 0
        if (asserted && !this.rstAsserted) {
          this.rstAsserted = true
        } else if (!asserted && this.rstAsserted) {
          this.rstAsserted = false
          this.resetCount += 1
          this.powerOn()
          this.ctx?.emit({ kind: 'reset', summary: 'Hardware reset (RST)' })
        }
        return
      }
      default:
        this.ctx?.diagnose('warn', `SSD1680 has no input line "${edge.signal}"`)
    }
  }

  // --- bus in ----------------------------------------------------------

  onBus(txn: BusTransaction): BusResponse {
    const miso = new Uint8Array(txn.mosi.length) // no MISO on the e-ink bus
    this.bytesOnBus += txn.mosi.length
    for (const byte of txn.mosi) {
      if (this.dc === 0) this.beginCommand(byte, txn.t)
      else this.consumeData(byte)
    }
    return { miso }
  }

  private beginCommand(cmd: number, t: number): void {
    this.pending = null
    this.writeTarget = null

    switch (cmd) {
      case CMD.SW_RESET:
        this.resetCount += 1
        this.softReset()
        return
      case CMD.NOP:
        return
      case CMD.MASTER_ACTIVATION:
        this.runUpdate(t)
        return
      case CMD.DEEP_SLEEP:
        this.pending = { cmd, params: [], need: 1 }
        return
      case CMD.DRIVER_OUTPUT_CONTROL:
        this.pending = { cmd, params: [], need: 3 }
        return
      case CMD.DATA_ENTRY_MODE:
      case CMD.BORDER_WAVEFORM:
      case CMD.DISPLAY_UPDATE_CONTROL_2:
        this.pending = { cmd, params: [], need: 1 }
        return
      case CMD.SET_RAM_X:
      case CMD.SET_RAM_X_COUNTER:
        this.pending = { cmd, params: [], need: cmd === CMD.SET_RAM_X ? 2 : 1 }
        return
      case CMD.SET_RAM_Y:
        this.pending = { cmd, params: [], need: 4 }
        return
      case CMD.SET_RAM_Y_COUNTER:
        this.pending = { cmd, params: [], need: 2 }
        return
      case CMD.WRITE_RAM_BW:
        this.writeTarget = 'bw'
        this.seatCursor()
        this.pending = { cmd, params: [], need: Number.POSITIVE_INFINITY }
        return
      case CMD.WRITE_RAM_RED:
        this.writeTarget = 'red'
        this.seatCursor()
        this.pending = { cmd, params: [], need: Number.POSITIVE_INFINITY }
        return
      case CMD.WRITE_LUT:
        this.customLut = true
        this.pending = { cmd, params: [], need: Number.POSITIVE_INFINITY }
        this.ctx?.emit({ kind: 'cmd', summary: 'Custom LUT loaded (fast/partial mode)' })
        return
    }

    if (IGNORED_WITH_PARAMS.has(cmd)) {
      this.pending = { cmd, params: [], need: Number.POSITIVE_INFINITY }
      return
    }

    this.ctx?.diagnose(
      'warn',
      `SSD1680: unimplemented command 0x${cmd.toString(16).padStart(2, '0')}`
    )
    this.pending = { cmd, params: [], need: Number.POSITIVE_INFINITY }
  }

  private consumeData(byte: number): void {
    const p = this.pending
    if (!p) {
      this.ctx?.diagnose('info', 'SSD1680: data byte with no command context')
      return
    }
    if (p.cmd === CMD.WRITE_RAM_BW || p.cmd === CMD.WRITE_RAM_RED) {
      this.writeRamByte(byte)
      return
    }
    if (p.need === Number.POSITIVE_INFINITY) return
    p.params.push(byte)
    if (p.params.length < p.need) return
    this.applyWithParams(p)
    this.pending = null
  }

  private applyWithParams(p: Pending): void {
    switch (p.cmd) {
      case CMD.DEEP_SLEEP:
        this.deepSleep = (p.params[0]! & 0x01) !== 0
        if (this.deepSleep) this.ctx?.emit({ kind: 'mode', summary: 'Deep sleep' })
        break
      case CMD.DRIVER_OUTPUT_CONTROL: {
        // params = [mux_lo, mux_hi, gd]; (mux + 1) is the gate count = height.
        const mux = ((p.params[1]! & 0x01) << 8) | p.params[0]!
        if (mux + 1 >= 100 && mux + 1 <= PANEL_H) {
          // Accepted; our RAM is fixed at PANEL_H rows, this is just a sanity read.
        }
        break
      }
      case CMD.DATA_ENTRY_MODE:
        this.entryMode = p.params[0]! & 0x07
        break
      case CMD.DISPLAY_UPDATE_CONTROL_2:
        this.updateSeq = p.params[0]!
        break
      case CMD.BORDER_WAVEFORM:
        break
      case CMD.SET_RAM_X:
        this.xStartByte = clamp(p.params[0]!, 0, BYTES_PER_ROW - 1)
        this.xEndByte = clamp(p.params[1]!, 0, BYTES_PER_ROW - 1)
        break
      case CMD.SET_RAM_Y:
        this.yStart = clamp((p.params[1]! << 8) | p.params[0]!, 0, PANEL_H - 1)
        this.yEnd = clamp((p.params[3]! << 8) | p.params[2]!, 0, PANEL_H - 1)
        break
      case CMD.SET_RAM_X_COUNTER:
        this.xByte = clamp(p.params[0]!, 0, BYTES_PER_ROW - 1)
        break
      case CMD.SET_RAM_Y_COUNTER:
        this.y = clamp((p.params[1]! << 8) | p.params[0]!, 0, PANEL_H - 1)
        break
    }
  }

  private seatCursor(): void {
    // A fresh WRITE_RAM starts at the window origin unless a counter command
    // has since moved it; the driver always sets both counters first, so honour
    // whatever they left.
    this.xByte = clamp(this.xByte, 0, BYTES_PER_ROW - 1)
    this.y = clamp(this.y, 0, PANEL_H - 1)
  }

  private writeRamByte(byte: number): void {
    const plane = this.writeTarget === 'red' ? this.ramRed : this.ramBw
    if (this.y >= 0 && this.y < PANEL_H && this.xByte >= 0 && this.xByte < BYTES_PER_ROW) {
      plane[this.y * BYTES_PER_ROW + this.xByte] = byte
    }
    // Advance the cursor. Data-entry bit1 = X direction, bit0 = Y direction.
    const xInc = (this.entryMode & 0x02) !== 0
    const yInc = (this.entryMode & 0x01) !== 0
    this.xByte += xInc ? 1 : -1
    if (this.xByte > this.xEndByte || this.xByte < this.xStartByte) {
      this.xByte = xInc ? this.xStartByte : this.xEndByte
      this.y += yInc ? 1 : -1
      if (this.y > this.yEnd) this.y = this.yStart
      if (this.y < this.yStart) this.y = this.yEnd
    }
  }

  private softReset(): void {
    // SW_RESET clears RAM to the default and re-reads OTP; it does NOT clear the
    // panel, but it does drive BUSY while it runs.
    this.pulseBusy()
    this.ramBw = new Uint8Array(BYTES_PER_ROW * PANEL_H).fill(0xff)
    this.ramRed = new Uint8Array(BYTES_PER_ROW * PANEL_H).fill(0xff)
    this.xStartByte = 0
    this.xEndByte = BYTES_PER_ROW - 1
    this.yStart = 0
    this.yEnd = PANEL_H - 1
    this.xByte = 0
    this.y = 0
    this.entryMode = 0x03
    this.customLut = false
    this.deepSleep = false
    this.ctx?.emit({ kind: 'reset', summary: 'Software reset (SW_RESET)' })
  }

  private runUpdate(t: number): void {
    const kind = refreshKindFor(this.updateSeq, this.customLut)
    this.lastRefresh = kind
    this.lastRefreshMs = REFRESH_MS[kind]
    this.refreshCount += 1
    if (kind !== 'full') this.partialCount += 1

    // Latch BW RAM to the panel. For a partial refresh the driver has only
    // written the changed window into RAM, but the panel keeps the rest — our
    // RAM already holds the whole plane, so a straight copy is correct.
    this.ramRed.set(this.visible) // previous frame becomes the "red"/reference plane
    this.visible.set(this.ramBw)
    this.markWindowDirty()

    this.pulseBusy()
    this.ctx?.emit({
      kind: 'refresh',
      summary: `${kind} refresh, ${this.lastRefreshMs} ms`,
      detail: { kind, ms: this.lastRefreshMs, seq: `0x${this.updateSeq.toString(16)}` }
    })
    void t
  }

  /**
   * Drive `BUSY` asserted then released around the update. The guest polls the
   * line *after* this transaction returns, so it reads "released" and proceeds
   * — the refresh latency is observable as the meter and event, not as a real
   * wall-clock stall (a v1 non-goal, same as the LR1110's `BUSY`).
   */
  private pulseBusy(): void {
    this.ctx?.driveSignal('BUSY', this.busyLevel(true))
    this.ctx?.driveSignal('BUSY', this.busyLevel(false))
  }

  private markWindowDirty(): void {
    this.dirty = { x0: 0, y0: 0, x1: PANEL_W - 1, y1: PANEL_H - 1 }
    this.frameDirty = true
  }

  // --- frame side channel ----------------------------------------------

  get hasFrame(): boolean {
    return this.frameDirty
  }

  /**
   * Hand the host the latched panel image as a packed 1bpp buffer (bit set =
   * white), plus the metadata the framebuffer message carries. Returns `null`
   * when nothing changed since the last call.
   */
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
    if (!this.frameDirty || !this.dirty) return null
    const d = this.dirty
    const frame = {
      width: PANEL_W,
      height: PANEL_H,
      madctl: 0,
      displayOn: !this.deepSleep,
      backlightOn: true, // e-ink is reflective; there is no backlight
      inverted: false,
      format: 'mono1' as const,
      dirty: { x: d.x0, y: d.y0, w: d.x1 - d.x0 + 1, h: d.y1 - d.y0 + 1 },
      pixels: this.visible.slice()
    }
    this.frameDirty = false
    this.dirty = null
    return frame
  }

  // --- observable state ----------------------------------------------

  snapshot(): DeviceSnapshot {
    return {
      panel: `${PANEL_W}×${PANEL_H} mono e-ink`,
      lastRefresh: this.lastRefresh,
      lastRefreshMs: this.lastRefreshMs,
      refreshes: this.refreshCount,
      partialRefreshes: this.partialCount,
      customLut: this.customLut,
      deepSleep: this.deepSleep,
      window: {
        x: this.xStartByte * 8,
        y: this.yStart,
        w: (this.xEndByte - this.xStartByte + 1) * 8,
        h: this.yEnd - this.yStart + 1
      },
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

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export const ssd1680Descriptor: DeviceModelDescriptor = {
  id: 'sitronix.ssd1680',
  summary:
    'SSD1680 250×122 monochrome e-paper. Command state machine, RAM window + BW/RED planes, LUT-driven full/fast/partial refresh, BUSY line, refresh-time meter; pixels latch on MASTER_ACTIVATION. Unimplemented opcodes raise a named diagnostic.',
  create: (options) => new Ssd1680Model(ssd1680Options(options))
}
