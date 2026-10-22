import { describe, expect, it } from 'vitest'
import { harness } from './harness'
import { BYTES_PER_ROW, PANEL_H, PANEL_W, PLANE_BYTES, Uc8151Model } from './uc8151'

const BUS = 'spi-disp'

/** Clock a command byte: DC low, one transaction, DC back high. */
function cmd(h: ReturnType<typeof harness>, byte: number): void {
  h.signal('DC', 0)
  h.bus({ bus: BUS, kind: 'spi', mosi: Uint8Array.of(byte) })
  h.signal('DC', 1)
}

/** Clock data bytes with DC high. */
function data(h: ReturnType<typeof harness>, ...bytes: number[]): void {
  h.signal('DC', 1)
  h.bus({ bus: BUS, kind: 'spi', mosi: Uint8Array.from(bytes) })
}

/** configFull(): PSR without the register-LUT bit, then CDI. */
function configFull(h: ReturnType<typeof harness>): void {
  cmd(h, 0x00)
  data(h, 0xcf) // PSR, bit5 clear
  cmd(h, 0x50)
  data(h, 0x97) // CDI
}

/** fastmodeOn(): configPartial() — PSR with bit5 set, then the five LUT loads. */
function configPartial(h: ReturnType<typeof harness>): void {
  cmd(h, 0x00)
  data(h, 0xef) // PSR, bit5 set
  cmd(h, 0x50)
  data(h, 0xd7)
  for (const lut of [0x20, 0x21, 0x22, 0x23, 0x24]) {
    cmd(h, lut)
    data(h, ...new Array<number>(56).fill(0x00))
  }
}

/** Write both image planes with `fill`. */
function writeImage(h: ReturnType<typeof harness>, fill: number): void {
  cmd(h, 0x10) // DTM1 (OLD)
  data(h, ...new Array<number>(PLANE_BYTES).fill(fill))
  cmd(h, 0x13) // DTM2 (NEW)
  data(h, ...new Array<number>(PLANE_BYTES).fill(fill))
}

/** activate(): PON -> DRF -> POF. */
function activate(h: ReturnType<typeof harness>): void {
  cmd(h, 0x04)
  cmd(h, 0x12)
  cmd(h, 0x02)
}

describe('Uc8151Model', () => {
  it('comes up as a 128×250 UC8151 panel, no refreshes', () => {
    const h = harness(new Uc8151Model())
    const s = h.snapshot()
    expect(s['panel']).toBe(`${PANEL_W}×${PANEL_H} mono e-ink (UC8151)`)
    expect(s['refreshes']).toBe(0)
    expect(PLANE_BYTES).toBe(BYTES_PER_ROW * PANEL_H)
  })

  it('runs configFull + image + activate without a diagnostic', () => {
    const h = harness(new Uc8151Model())
    configFull(h)
    writeImage(h, 0x00)
    activate(h)
    expect(h.diagnostics).toEqual([])
  })

  it('latches the NEW plane to the panel on DRF (0x12), not on the image write', () => {
    const model = new Uc8151Model()
    const h = harness(model)
    configFull(h)
    // Drain the power-on white frame.
    expect([...model.takeFrame()!.pixels].every((b) => b === 0xff)).toBe(true)

    writeImage(h, 0x00) // all black into both planes
    expect(model.takeFrame()).toBeNull() // no refresh yet
    expect(h.snapshot()['refreshes']).toBe(0)

    cmd(h, 0x04) // PON
    cmd(h, 0x12) // DRF
    const frame = model.takeFrame()
    expect(frame).not.toBeNull()
    expect(frame!.format).toBe('mono1')
    expect(frame!.width).toBe(PANEL_W)
    expect(frame!.height).toBe(PANEL_H)
    expect([...frame!.pixels].every((b) => b === 0x00)).toBe(true)
    cmd(h, 0x02) // POF
  })

  it('BUSY is active-low: idles high, pulses low across PON and DRF', () => {
    const h = harness(new Uc8151Model())
    // Idle: not busy => pin HIGH for an active-low BUSY.
    expect(h.line('BUSY')).toBe(1)
    configFull(h)
    writeImage(h, 0xff)
    h.driven.length = 0
    cmd(h, 0x04) // PON — one low/high pulse
    cmd(h, 0x12) // DRF — one low/high pulse
    cmd(h, 0x02)
    expect(h.driven).toEqual([
      { signal: 'BUSY', level: 0 },
      { signal: 'BUSY', level: 1 },
      { signal: 'BUSY', level: 0 },
      { signal: 'BUSY', level: 1 }
    ])
    expect(h.line('BUSY')).toBe(1)
    expect(h.meter('refreshMs')).toBe(2000)
    expect(h.snapshot()['lastRefresh']).toBe('full')
  })

  it('a partial config (LUTs + PSR bit5) makes DRF a fast refresh', () => {
    const h = harness(new Uc8151Model())
    configFull(h)
    writeImage(h, 0xff)
    activate(h)
    expect(h.meter('refreshMs')).toBe(2000)

    configPartial(h)
    cmd(h, 0x13)
    data(h, ...new Array<number>(PLANE_BYTES).fill(0x00))
    activate(h)
    expect(h.snapshot()['lastRefresh']).toBe('partial')
    expect(h.meter('refreshMs')).toBe(480)
    expect(h.meter('partialShare')).toBe(50) // 1 of 2
  })

  it('raises a named diagnostic for an unknown opcode', () => {
    const h = harness(new Uc8151Model())
    cmd(h, 0xaa)
    expect(h.diagnostics).toEqual([
      { severity: 'warn', message: 'UC8151: unimplemented command 0xaa' }
    ])
  })

  it('reads BUSY low while RST is held — steers detectEInk() to this driver', () => {
    const h = harness(new Uc8151Model())
    expect(h.line('BUSY')).toBe(1) // idle, active-low => HIGH
    h.signal('RST', 0) // E213Display::detectEInk() holds RST and reads BUSY
    expect(h.line('BUSY')).toBe(0) // busy => LOW => picks LCMEN2R13EFC1 (UC8151)
    h.signal('RST', 1)
    expect(h.line('BUSY')).toBe(1)
  })

  it('honours a hardware reset on the RST line', () => {
    const model = new Uc8151Model()
    const h = harness(model)
    configPartial(h)
    writeImage(h, 0x00)
    activate(h)
    model.takeFrame()
    expect(h.snapshot()['customLut']).toBe(true)
    const before = h.snapshot()['resetCount'] as number
    h.signal('RST', 0)
    h.signal('RST', 1)
    expect(h.snapshot()['resetCount']).toBe(before + 1)
    expect(h.snapshot()['customLut']).toBe(false)
    // RAM cleared to white.
    cmd(h, 0x04)
    cmd(h, 0x12)
    expect([...model.takeFrame()!.pixels].every((b) => b === 0xff)).toBe(true)
  })
})
