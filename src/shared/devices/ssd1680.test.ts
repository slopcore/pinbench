import { describe, expect, it } from 'vitest'
import { harness } from './harness'
import { BYTES_PER_ROW, PANEL_H, PANEL_W, Ssd1680Model } from './ssd1680'

const BUS = 'spi-disp'

/** Clock a command byte: DC low, one transaction, DC back high (as the driver does). */
function cmd(h: ReturnType<typeof harness>, byte: number): void {
  h.signal('DC', 0)
  h.bus({ bus: BUS, kind: 'spi', mosi: Uint8Array.of(byte) })
  h.signal('DC', 1)
}

/** Clock parameter / data bytes with DC high. */
function data(h: ReturnType<typeof harness>, ...bytes: number[]): void {
  h.signal('DC', 1)
  h.bus({ bus: BUS, kind: 'spi', mosi: Uint8Array.from(bytes) })
}

/** The SSD1680 bring-up the heltec-eink-modules driver issues, condensed. */
function init(h: ReturnType<typeof harness>): void {
  cmd(h, 0x12) // SW_RESET
  cmd(h, 0x01)
  data(h, 0x79, 0x00, 0x00) // DRIVER_OUTPUT_CONTROL: 122 gates
  cmd(h, 0x11)
  data(h, 0x03) // DATA_ENTRY_MODE: X inc, Y inc
  cmd(h, 0x44)
  data(h, 0x00, BYTES_PER_ROW - 1) // RAM X window
  cmd(h, 0x45)
  data(h, 0x00, 0x00, PANEL_H - 1, 0x00) // RAM Y window
  cmd(h, 0x3c)
  data(h, 0x05) // BORDER_WAVEFORM
}

/** Seat the write cursor and stream a full BW plane of `fill`. */
function writeFullFrame(h: ReturnType<typeof harness>, fill: number): void {
  cmd(h, 0x4e)
  data(h, 0x00) // X counter
  cmd(h, 0x4f)
  data(h, 0x00, 0x00) // Y counter
  cmd(h, 0x24) // WRITE_RAM_BW
  data(h, ...new Array<number>(BYTES_PER_ROW * PANEL_H).fill(fill))
}

/** Arm and run a display update. `seq` picks the waveform. */
function refresh(h: ReturnType<typeof harness>, seq: number): void {
  cmd(h, 0x22)
  data(h, seq)
  cmd(h, 0x20) // MASTER_ACTIVATION
}

describe('Ssd1680Model', () => {
  it('comes up as a 250×122 mono panel, no refreshes yet', () => {
    const model = new Ssd1680Model()
    const h = harness(model)
    const s = h.snapshot()
    expect(s['panel']).toBe(`${PANEL_W}×${PANEL_H} mono e-ink`)
    expect(s['refreshes']).toBe(0)
    expect(s['deepSleep']).toBe(false)
  })

  it('runs the bring-up sequence without a diagnostic', () => {
    const model = new Ssd1680Model()
    const h = harness(model)
    init(h)
    expect(h.diagnostics).toEqual([])
  })

  it('latches RAM to the panel only on MASTER_ACTIVATION', () => {
    const model = new Ssd1680Model()
    const h = harness(model)
    init(h)
    // Drain the power-on frame (a blank white panel).
    const initial = model.takeFrame()
    expect(initial).not.toBeNull()
    expect([...initial!.pixels].every((b) => b === 0xff)).toBe(true)

    writeFullFrame(h, 0x00) // all black into RAM
    // The write alone does not refresh — no new frame, no refresh counted.
    expect(h.snapshot()['refreshes']).toBe(0)
    expect(model.takeFrame()).toBeNull()

    refresh(h, 0xf7)
    const frame = model.takeFrame()
    expect(frame).not.toBeNull()
    expect(frame!.format).toBe('mono1')
    expect(frame!.width).toBe(PANEL_W)
    expect(frame!.height).toBe(PANEL_H)
    expect(frame!.pixels.length).toBe(BYTES_PER_ROW * PANEL_H)
    // All black => every bit cleared.
    expect([...frame!.pixels].every((b) => b === 0x00)).toBe(true)
  })

  it('pulses BUSY around a refresh and reports its modelled duration', () => {
    const model = new Ssd1680Model()
    const h = harness(model)
    init(h)
    h.driven.length = 0
    writeFullFrame(h, 0xff)
    refresh(h, 0xf7) // full

    // BUSY asserted (high, Solomon Systech default) then released within the update.
    expect(h.driven).toEqual([
      { signal: 'BUSY', level: 1 },
      { signal: 'BUSY', level: 0 }
    ])
    expect(h.line('BUSY')).toBe(0)
    expect(h.meter('refreshMs')).toBe(2600)
    expect(h.snapshot()['lastRefresh']).toBe('full')
  })

  it('a loaded LUT turns subsequent updates into fast partial refreshes', () => {
    const model = new Ssd1680Model()
    const h = harness(model)
    init(h)
    writeFullFrame(h, 0xff)
    refresh(h, 0xf7) // full
    expect(h.meter('refreshMs')).toBe(2600)

    cmd(h, 0x32) // WRITE_LUT — the driver's fastmodeOn()
    data(h, ...new Array<number>(153).fill(0x00))
    writeFullFrame(h, 0x00)
    refresh(h, 0xff) // LUT-driven
    expect(h.snapshot()['lastRefresh']).toBe('partial')
    expect(h.meter('refreshMs')).toBe(340)
    expect(h.meter('partialShare')).toBe(50) // 1 of 2
  })

  it('SW_RESET pulses BUSY and clears controller RAM', () => {
    const model = new Ssd1680Model()
    const h = harness(model)
    init(h)
    writeFullFrame(h, 0x00)
    h.driven.length = 0
    cmd(h, 0x12) // SW_RESET
    expect(h.driven).toEqual([
      { signal: 'BUSY', level: 1 },
      { signal: 'BUSY', level: 0 }
    ])
    // A refresh now shows white (RAM was cleared to 0xFF).
    refresh(h, 0xf7)
    const frame = model.takeFrame()
    expect([...frame!.pixels].every((b) => b === 0xff)).toBe(true)
  })

  it('raises a named diagnostic for an unknown opcode', () => {
    const model = new Ssd1680Model()
    const h = harness(model)
    cmd(h, 0x99)
    expect(h.diagnostics).toEqual([
      { severity: 'warn', message: 'SSD1680: unimplemented command 0x99' }
    ])
  })

  it('honours a hardware reset on the RST line', () => {
    const model = new Ssd1680Model()
    const h = harness(model)
    init(h)
    writeFullFrame(h, 0x00)
    refresh(h, 0xf7)
    model.takeFrame()
    const before = h.snapshot()['resetCount'] as number
    h.signal('RST', 0)
    h.signal('RST', 1)
    expect(h.snapshot()['resetCount']).toBe(before + 1)
    // Controller RAM is back to the power-on default, so a refresh shows white.
    refresh(h, 0xf7)
    const frame = model.takeFrame()
    expect([...frame!.pixels].every((b) => b === 0xff)).toBe(true)
  })
})
