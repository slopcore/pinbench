/**
 * The device-host → renderer message shapes, crossing the preload bridge.
 *
 * Kept here rather than in `src/main/devices.ts` so the preload and renderer
 * can import them without pulling in `node:net`. The host produces them; the
 * OUT panels consume them.
 */

import type { DeviceEvent } from './model'

/** One part's observable state, pushed whenever it changes. */
export interface DeviceSnapshotMessage {
  partId: string
  deviceModel: string
  designator: string
  name: string
  /** Structured-clonable model state. */
  state: Record<string, unknown>
  /** Declared meters resolved to their current values. */
  meters: DeviceMeterValue[]
  /** True once the model threw and was quarantined until reset. */
  quarantined: boolean
}

export interface DeviceMeterValue {
  id: string
  label: string
  unit?: string
  value: number | undefined
}

/** One row for a part's OUT-panel event log. */
export interface DeviceEventMessage {
  partId: string
  event: DeviceEvent & { t: number }
}

/** A command from an IN panel, renderer → host (wired from M7/M8). */
export interface DeviceCommandMessage {
  partId: string
  command: string
  args?: Record<string, unknown>
}

/**
 * A display framebuffer, host → renderer, down a channel of its own.
 *
 * ADR 0001's rule is that a device model is handed whole buffers, never bytes;
 * the corollary M6 adds is that a 153,600-byte framebuffer must not ride in
 * {@link DeviceSnapshotMessage}, which the host JSON-stringifies on every
 * transaction to dedupe. The host pulls this from the model on a refresh-rate
 * timer instead and posts it here as a transferable. For `rgb565` (the ST7789)
 * `pixels` is one `uint16` per pixel, row major; for `mono1` (the Heltec e-ink
 * panel) it is a packed 1-bit-per-pixel buffer, `ceil(width / 8)` bytes per row,
 * bit set = white. The OUT panel applies `madctl` rotation for the ST7789; the
 * e-ink panel bakes its rotation into the buffer and leaves `madctl` at 0.
 */
export interface DeviceFramebufferMessage {
  partId: string
  deviceModel: string
  /** GRAM dimensions, before any MADCTL rotation. */
  width: number
  height: number
  /** The raw MADCTL register value, for the panel's display transform. */
  madctl: number
  displayOn: boolean
  backlightOn: boolean
  /** INVON state — the renderer inverts at scan-out, as real hardware does. */
  inverted: boolean
  /** Pixel encoding of `pixels`. Defaults to `rgb565` when absent (pre-M13 hosts). */
  format?: 'rgb565' | 'mono1'
  /** The region that changed since the previous message, in GRAM coordinates. */
  dirty: { x: number; y: number; w: number; h: number }
  /** `rgb565`: `width * height` uint16, row major. `mono1`: packed 1bpp, row major. */
  pixels: ArrayBuffer
}
