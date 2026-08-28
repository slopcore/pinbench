import { describe, expect, it } from 'vitest'
import { harness } from './harness'
import { GRAM_W, St7789Model } from './st7789'

/** Clock a command byte: DC low, one transaction, DC back high (as the driver does). */
function cmd(h: ReturnType<typeof harness>, byte: number): void {
  h.signal('DC', 0)
  h.bus({ bus: 'spi0', kind: 'spi', mosi: Uint8Array.of(byte) })
  h.signal('DC', 1)
}

/** Clock parameter / data bytes with DC high. */
function data(h: ReturnType<typeof harness>, ...bytes: number[]): void {
  h.signal('DC', 1)
  h.bus({ bus: 'spi0', kind: 'spi', mosi: Uint8Array.from(bytes) })
}

/** The init sequence MeshCore's ST7789Spi::sendInitCommands issues, condensed. */
function init(h: ReturnType<typeof harness>): void {
  cmd(h, 0x01) // SWRESET
  cmd(h, 0x11) // SLPOUT
  cmd(h, 0x3a)
  data(h, 0x55) // COLMOD 16bpp
  cmd(h, 0x36)
  data(h, 0x20 | 0x40) // MADCTL: MV | MX (landscape)
  cmd(h, 0x29) // DISPON
  cmd(h, 0x21) // INVON
}

describe('St7789Model', () => {
  it('comes up powered off and dark', () => {
    const model = new St7789Model()
    const h = harness(model)
    const s = h.snapshot()
    expect(s['poweredOn']).toBe(false)
    expect(s['displayOn']).toBe(false)
    expect(s['backlightOn']).toBe(false)
    expect(s['bpp']).toBe(16)
  })

  it('walks the init sequence into observable state', () => {
    const model = new St7789Model()
    const h = harness(model)
    init(h)
    const s = h.snapshot()
    expect(s['poweredOn']).toBe(true) // SLPOUT
    expect(s['displayOn']).toBe(true) // DISPON
    expect(s['inverted']).toBe(true) // INVON
    expect(s['madctl']).toBe(0x60)
  })

  it('reads a command byte from DC-low and its params from DC-high', () => {
    const model = new St7789Model()
    const h = harness(model)
    cmd(h, 0x3a)
    data(h, 0x66) // 18bpp
    expect(h.snapshot()['bpp']).toBe(18)
  })

  it('RAMWR fills the CASET/RASET window and the frame carries a tight dirty rect', () => {
    const model = new St7789Model()
    const h = harness(model)
    model.takeFrame() // drain the power-on clear-to-black frame
    // No MADCTL — straight GRAM addressing.
    cmd(h, 0x2a)
    data(h, 0x00, 0x02, 0x00, 0x04) // CASET cols 2..4
    cmd(h, 0x2b)
    data(h, 0x00, 0x01, 0x00, 0x02) // RASET rows 1..2
    cmd(h, 0x2c) // RAMWR
    // 3 cols × 2 rows = 6 pixels, 12 bytes, all 0xF800 (red)
    data(h, ...Array(6).fill([0xf8, 0x00]).flat())

    const frame = model.takeFrame()
    expect(frame).not.toBeNull()
    expect(frame!.dirty).toEqual({ x: 2, y: 1, w: 3, h: 2 })
    expect(frame!.pixels[1 * GRAM_W + 2]).toBe(0xf800)
    expect(frame!.pixels[2 * GRAM_W + 4]).toBe(0xf800)
    // Outside the window is untouched.
    expect(frame!.pixels[0]).toBe(0x0000)
  })

  it('takeFrame clears the dirty state until the next write', () => {
    const model = new St7789Model()
    const h = harness(model)
    model.takeFrame() // clear the power-on full-frame dirty
    expect(model.takeFrame()).toBeNull()

    cmd(h, 0x2c)
    data(h, 0x12, 0x34)
    expect(model.takeFrame()).not.toBeNull()
    expect(model.takeFrame()).toBeNull()
  })

  it('MADCTL MV swaps the RAMWR fast axis', () => {
    const model = new St7789Model()
    const h = harness(model)
    model.takeFrame()
    cmd(h, 0x36)
    data(h, 0x20) // MV only
    cmd(h, 0x2a)
    data(h, 0x00, 0x00, 0x00, 0x03) // cols 0..3
    cmd(h, 0x2b)
    data(h, 0x00, 0x00, 0x00, 0x01) // rows 0..1
    cmd(h, 0x2c)
    // First two pixels with MV go down column 0 (row 0 then row 1), not across.
    data(h, 0x11, 0x11, 0x22, 0x22)
    const frame = model.takeFrame()!
    expect(frame.pixels[0 * GRAM_W + 0]).toBe(0x1111)
    expect(frame.pixels[1 * GRAM_W + 0]).toBe(0x2222)
  })

  it('a hardware RST pulse returns the panel to power-on', () => {
    const model = new St7789Model()
    const h = harness(model)
    init(h)
    expect(h.snapshot()['poweredOn']).toBe(true)
    h.signal('RST', 0)
    h.signal('RST', 1)
    const s = h.snapshot()
    expect(s['poweredOn']).toBe(false)
    expect(s['displayOn']).toBe(false)
    expect(s['resetCount']).toBe(2) // SWRESET in init(), then this RST pulse
  })

  it('raises a named diagnostic for an unimplemented command, never silent', () => {
    const model = new St7789Model()
    const h = harness(model)
    cmd(h, 0x99)
    expect(h.diagnostics.some((d) => d.severity === 'warn' && d.message.includes('0x99'))).toBe(
      true
    )
  })

  it('tracks the backlight line with configurable polarity', () => {
    const model = new St7789Model({ backlightActiveHigh: false })
    const h = harness(model)
    h.signal('BL', 0)
    expect(h.snapshot()['backlightOn']).toBe(true)
    h.signal('BL', 1)
    expect(h.snapshot()['backlightOn']).toBe(false)
  })

  it('splits a 16bpp pixel across two transactions without dropping it', () => {
    const model = new St7789Model()
    const h = harness(model)
    cmd(h, 0x2c)
    data(h, 0x07) // high byte only
    data(h, 0xe0) // low byte — completes 0x07E0 (green)
    const frame = model.takeFrame()!
    expect(frame.pixels[0]).toBe(0x07e0)
  })

  it('powers on in command mode — a first command with no DC edge is not a stray data byte', () => {
    const model = new St7789Model()
    const h = harness(model)
    // No h.signal('DC', ...) at all: the fork's observer swallows an initial
    // digitalWrite(DC, LOW) over a reset-0 register, so the model must already
    // be in command mode.
    h.bus({ bus: 'spi0', kind: 'spi', mosi: Uint8Array.of(0x11) }) // SLPOUT
    expect(h.snapshot()['poweredOn']).toBe(true)
    expect(h.diagnostics.some((d) => d.message.includes('no command context'))).toBe(false)
  })

  it('flush meter spans the whole frame, not the last of ~240 per-row RAMWRs', () => {
    const model = new St7789Model()
    const h = harness(model)
    model.takeFrame() // drain power-on frame
    const ramwr = (t: number): void => {
      h.signal('DC', 0)
      h.bus({ bus: 'spi0', kind: 'spi', mosi: Uint8Array.of(0x2c), t })
    }
    const pixel = (t: number): void => {
      h.signal('DC', 1)
      h.bus({ bus: 'spi0', kind: 'spi', mosi: Uint8Array.of(0x11, 0x11), t })
    }
    // Two per-row RAMWRs (as MeshCore's per-row setAddrWindow does), the first
    // at 1_000_000 ns, the last pixel at 4_000_000.
    ramwr(1_000_000)
    pixel(1_500_000)
    ramwr(2_500_000)
    pixel(4_000_000)

    model.takeFrame()
    // span = 4_000_000 - 1_000_000 ns = 3.00 ms, not the 1.5 ms of the last RAMWR.
    expect(model.meter('flush')).toBe(3)
  })
})
