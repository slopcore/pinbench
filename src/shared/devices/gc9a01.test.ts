import { describe, expect, it } from 'vitest'
import { harness } from './harness'
import { gc9a01Descriptor } from './gc9a01'

type H = ReturnType<typeof harness>

/** One `esp_lcd_panel_io_tx_param`: the command with DC low, its params with DC high. */
function tx(h: H, cmd: number, ...params: number[]): void {
  h.signal('DC', 0)
  h.bus({ bus: 'spi2', kind: 'spi', mosi: Uint8Array.of(cmd) })
  h.signal('DC', 1)
  if (params.length) h.bus({ bus: 'spi2', kind: 'spi', mosi: Uint8Array.from(params) })
}

/** Waveshare's `lcd_panel_init`, byte for byte (GC9A01.cpp, Arduino-v3.2.1 LVGL demo). */
function waveshareInit(h: H): void {
  tx(h, 0xef)
  tx(h, 0xeb, 0x14)
  tx(h, 0xfe)
  tx(h, 0xef)
  tx(h, 0xeb, 0x14)
  tx(h, 0x84, 0x40)
  tx(h, 0x85, 0xff)
  tx(h, 0x86, 0xff)
  tx(h, 0x87, 0xff)
  tx(h, 0x88, 0x0a)
  tx(h, 0x89, 0x21)
  tx(h, 0x8a, 0x00)
  tx(h, 0x8b, 0x80)
  tx(h, 0x8c, 0x01)
  tx(h, 0x8d, 0x01)
  tx(h, 0x8e, 0xff)
  tx(h, 0x8f, 0xff)
  tx(h, 0xb6, 0x00, 0x20)
  tx(h, 0x36, 0x08)
  tx(h, 0x3a, 0x05)
  tx(h, 0x90, 0x08, 0x08, 0x08, 0x08)
  tx(h, 0xbd, 0x06)
  tx(h, 0xbc, 0x00)
  tx(h, 0xff, 0x60, 0x01, 0x04)
  tx(h, 0xc3, 0x13)
  tx(h, 0xc4, 0x13)
  tx(h, 0xc9, 0x22)
  tx(h, 0xbe, 0x11)
  tx(h, 0xe1, 0x10, 0x0e)
  tx(h, 0xdf, 0x21, 0x0c, 0x02)
  tx(h, 0xf0, 0x45, 0x09, 0x08, 0x08, 0x26, 0x2a)
  tx(h, 0xf1, 0x43, 0x70, 0x72, 0x36, 0x37, 0x6f)
  tx(h, 0xf2, 0x45, 0x09, 0x08, 0x08, 0x26, 0x2a)
  tx(h, 0xf3, 0x43, 0x70, 0x72, 0x36, 0x37, 0x6f)
  tx(h, 0xed, 0x1b, 0x0b)
  tx(h, 0xae, 0x77)
  tx(h, 0xcd, 0x63)
  tx(h, 0x70, 0x07, 0x07, 0x04, 0x0e, 0x0f, 0x09, 0x07, 0x08, 0x03)
  tx(h, 0xe8, 0x34)
  tx(h, 0x62, 0x18, 0x0d, 0x71, 0xed, 0x70, 0x70, 0x18, 0x0f, 0x71, 0xef, 0x70, 0x70)
  tx(h, 0x63, 0x18, 0x11, 0x71, 0xf1, 0x70, 0x70, 0x18, 0x13, 0x71, 0xf3, 0x70, 0x70)
  tx(h, 0x64, 0x28, 0x29, 0xf1, 0x01, 0xf1, 0x00, 0x07)
  tx(h, 0x66, 0x3c, 0x00, 0xcd, 0x67, 0x45, 0x45, 0x10, 0x00, 0x00, 0x00)
  tx(h, 0x67, 0x00, 0x3c, 0x00, 0x00, 0x00, 0x01, 0x54, 0x10, 0x32, 0x98)
  tx(h, 0x74, 0x10, 0x85, 0x80, 0x00, 0x00, 0x4e, 0x00)
  tx(h, 0x98, 0x3e, 0x07)
  tx(h, 0x35)
  tx(h, 0x21)
  tx(h, 0x11)
  tx(h, 0x29)
}

function make(): { h: H; model: ReturnType<typeof gc9a01Descriptor.create> } {
  const model = gc9a01Descriptor.create({})
  return { h: harness(model), model }
}

describe('GC9A01 (Waveshare ESP32-C6-Touch-LCD-1.28)', () => {
  it('walks the real Waveshare init sequence with no diagnostics', () => {
    const { h } = make()
    waveshareInit(h)
    expect(h.diagnostics).toEqual([])
    const s = h.snapshot()
    expect(s['poweredOn']).toBe(true)
    expect(s['displayOn']).toBe(true)
    expect(s['inverted']).toBe(true) // the controller's INVON state
    expect(s['madctl']).toBe(0x08)
    expect(s['bpp']).toBe(16)
  })

  it('has a square 240×240 GRAM and a full-screen flush lands every pixel', () => {
    const { h, model } = make()
    waveshareInit(h)
    const frameSource = model as unknown as {
      takeFrame(): { width: number; height: number; pixels: Uint16Array } | null
    }
    frameSource.takeFrame() // drain the power-on frame

    // lcd_flush(): CASET / RASET / RAMWR over the whole panel, LVGL's swapped RGB565.
    tx(h, 0x2a, 0x00, 0x00, 0x00, 0xef)
    tx(h, 0x2b, 0x00, 0x00, 0x00, 0xef)
    tx(h, 0x2c)
    const px = new Uint8Array(240 * 240 * 2)
    for (let i = 0; i < px.length; i += 2) {
      px[i] = 0x07 // 0x07E0 green, high byte first on the wire
      px[i + 1] = 0xe0
    }
    h.bus({ bus: 'spi2', kind: 'spi', mosi: px })

    const f = frameSource.takeFrame()
    expect(f).not.toBeNull()
    expect(f!.width).toBe(240)
    expect(f!.height).toBe(240)
    expect(f!.pixels.length).toBe(240 * 240)
    expect(f!.pixels[0]).toBe(0x07e0)
    expect(f!.pixels[239 * 240 + 239]).toBe(0x07e0)
  })

  it('reports true colour under INVON — the glass is normally-black', () => {
    const { h, model } = make()
    const frameSource = model as unknown as { takeFrame(): { inverted: boolean } | null }
    waveshareInit(h) // sends INVON
    expect(frameSource.takeFrame()!.inverted).toBe(false)
    tx(h, 0x20) // INVOFF
    expect(frameSource.takeFrame()!.inverted).toBe(true)
  })

  it('names itself in diagnostics, not as an ST7789', () => {
    const { h } = make()
    tx(h, 0xa5, 0x01) // not a GC9A01 opcode the driver sends
    expect(
      h.diagnostics.some((d) => d.message.startsWith('GC9A01: unimplemented command 0xa5'))
    ).toBe(true)
  })
})
