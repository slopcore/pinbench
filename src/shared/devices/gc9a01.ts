/**
 * GalaxyCore GC9A01 — the 1.28" 240×240 round IPS panel on the Waveshare
 * ESP32-C6-Touch-LCD-1.28.
 *
 * The GC9A01 is a MIPI-DCS controller: CASET / RASET / RAMWR / MADCTL / COLMOD /
 * INVON / SLPOUT / DISPON are the ST7789's opcodes with the ST7789's meaning, so
 * this is {@link St7789Model} with a square 240×240 GRAM and the GC9A01's vendor
 * init opcodes swallowed. The opcode list is transcribed from Waveshare's own
 * driver (`examples/Arduino-v3.2.1/07_LVGL_Demo/GC9A01.cpp`, `lcd_panel_init`),
 * not from a generic GC9A01 library.
 *
 * Two board facts the driver makes visible:
 *   - It always sends `INVON` (0x21): the glass is normally-black, and only
 *     shows true colour inverted. Hence `nativeInversion`.
 *   - `MADCTL` = 0x08 (BGR). The renderer does not swap channels for BGR — the
 *     bit says the panel's subpixel order matches, so RGB565 from LVGL lands
 *     right.
 *
 * The round glass is drawn by the renderer; GRAM itself is square, and the
 * corners are simply never seen on the real part.
 */

import type { DeviceModelDescriptor } from './model'
import { St7789Model, st7789Options, type PanelVariant } from './st7789'

/** Vendor / power / gamma opcodes from Waveshare's `lcd_panel_init`. */
export const GC9A01_VENDOR_COMMANDS: readonly number[] = [
  0xef, // inter register enable 2 (no params)
  0xfe, // inter register enable 1 (no params)
  0xeb,
  0x84,
  0x85,
  0x86,
  0x87,
  0x88,
  0x89,
  0x8a,
  0x8b,
  0x8c,
  0x8d,
  0x8e,
  0x8f,
  0xb6, // display function control
  0x90,
  0xbd,
  0xbc,
  0xff,
  0xc9,
  0xbe,
  0xdf,
  0xed,
  0xae,
  0xcd,
  0x70,
  0x62,
  0x63,
  0x64,
  0x66,
  0x67,
  0x74,
  0x98
]

export const GC9A01_VARIANT: PanelVariant = {
  id: 'galaxycore.gc9a01',
  label: 'GC9A01',
  gramWidth: 240,
  gramHeight: 240,
  ignoredCommands: GC9A01_VENDOR_COMMANDS,
  nativeInversion: true
}

export const gc9a01Descriptor: DeviceModelDescriptor = {
  id: GC9A01_VARIANT.id,
  summary:
    'GC9A01 240×240 round SPI panel. The ST7789 command state machine with a square GRAM, GC9A01 vendor init opcodes and a normally-black (INVON = true colour) glass.',
  create: (options) => new St7789Model(st7789Options(options), GC9A01_VARIANT)
}
