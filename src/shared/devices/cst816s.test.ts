import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { harness } from './harness'
import { CST816S_ADDRESS, Cst816sModel } from './cst816s'

type H = ReturnType<typeof harness>

/** Wire's register read: write the pointer, then read `n` (two address phases). */
function readReg(h: H, reg: number, n: number): number[] {
  h.bus({ bus: 'i2c0', kind: 'i2c', select: CST816S_ADDRESS, mosi: Uint8Array.of(reg) })
  return [
    ...h.bus({
      bus: 'i2c0',
      kind: 'i2c',
      select: CST816S_ADDRESS,
      mosi: new Uint8Array(n),
      read: true
    })
  ]
}

describe('Cst816sModel', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('answers on 0x15 with chip id 0xB5 at 0xA7, as begin() reads it', () => {
    const model = new Cst816sModel()
    const h = harness(model)
    expect(model.i2cAddress).toBe(0x15)
    expect(readReg(h, 0x15, 1)).toEqual([0x01])
    expect(readReg(h, 0xa7, 3)).toEqual([0xb5, 0x00, 0x01])
  })

  it('a touch pulses INT low and lays out the 6-byte report read_touch() decodes', () => {
    const h = harness(new Cst816sModel())
    expect(h.line('INT')).toBe(1)
    h.command('touch', { x: 300, y: 17 }) // x clamps to 239
    expect(h.line('INT')).toBe(0)
    // The pulse rises on its own — a RISING-edge ISR (Waveshare's default) needs that.
    vi.advanceTimersByTime(50)
    expect(h.line('INT')).toBe(1)

    const [gesture, points, xh, xl, yh, yl] = readReg(h, 0x01, 6)
    expect(gesture).toBe(0)
    expect(points).toBe(1)
    expect(xh! >> 6).toBe(0) // event: down
    expect(((xh! & 0xf) << 8) | xl!).toBe(239)
    expect(((yh! & 0xf) << 8) | yl!).toBe(17)
  })

  it('tap is a down report then, tapMs later, a lift', () => {
    const h = harness(new Cst816sModel())
    h.command('tap', { x: 120, y: 60 })
    expect(readReg(h, 0x02, 1)).toEqual([1])
    vi.advanceTimersByTime(120)
    const [gesture, points, xh] = readReg(h, 0x01, 3)
    expect(points).toBe(0)
    expect(xh! >> 6).toBe(1)
    expect(gesture).toBe(0x05) // single click
  })

  it('a lift reports event 1 with no fingers', () => {
    const h = harness(new Cst816sModel())
    h.command('touch', { x: 10, y: 20 })
    readReg(h, 0x01, 6)
    h.command('release')
    expect(h.line('INT')).toBe(0)
    const [, points, xh] = readReg(h, 0x01, 6)
    expect(points).toBe(0)
    expect(xh! >> 6).toBe(1)
  })

  it('writes land at the pointer with auto-increment (the standby write)', () => {
    const h = harness(new Cst816sModel())
    h.bus({ bus: 'i2c0', kind: 'i2c', select: 0x15, mosi: Uint8Array.of(0xa5, 0x03) })
    expect(readReg(h, 0xa5, 1)).toEqual([0x03])
  })

  it('RST low clears a pending report and releases INT', () => {
    const h = harness(new Cst816sModel())
    h.command('touch', { x: 1, y: 1 })
    h.signal('RST', 0)
    expect(h.line('INT')).toBe(1)
    h.signal('RST', 1)
    expect(readReg(h, 0x02, 1)).toEqual([0])
  })

  it('ignores the bus-line pin-enable edges', () => {
    const h = harness(new Cst816sModel())
    h.signal('SDA', 1)
    h.signal('SCL', 1)
    expect(h.diagnostics).toEqual([])
  })
})
