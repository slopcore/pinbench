import { useEffect, useRef } from 'react'
import type { DeviceFramebufferMessage } from '@shared/devices/messages'

interface St7789ScreenProps {
  framebuffer: DeviceFramebufferMessage | undefined
  /** Panel-zoom from the Inspector: `1`, `2` or `3`. */
  zoom: number
  /** Viewer rotation applied on top of the firmware's own MADCTL, in degrees:
      `0`, `90`, `180` or `270`. Purely a CSS transform on scan-out. */
  rotate?: number
}

const MADCTL_MV = 0x20

/**
 * Map a dirty rect in physical GRAM coords to a display-space rect, clamped to
 * the canvas. With MV the display is GRAM transposed, so `dx = physY`,
 * `dy = physX`.
 */
export function displayDirtyRect(
  mv: boolean,
  dispW: number,
  dispH: number,
  d: { x: number; y: number; w: number; h: number }
): { x0: number; y0: number; x1: number; y1: number } {
  const x0 = clamp(mv ? d.y : d.x, 0, dispW)
  const y0 = clamp(mv ? d.x : d.y, 0, dispH)
  const x1 = clamp(mv ? d.y + d.h : d.x + d.w, 0, dispW)
  const y1 = clamp(mv ? d.x + d.w : d.y + d.h, 0, dispH)
  return { x0, y0, x1, y1 }
}

/**
 * The ST7789's OUT-panel picture: the GRAM the model accumulated from real
 * `RAMWR` traffic, drawn at native resolution and CSS-scaled to the chosen
 * zoom. `MADCTL`'s MV bit transposes GRAM to the landscape the M9 firmware runs
 * in (MX/MY and the physical-cell mapping are already baked into GRAM addresses
 * by the model, the way the panel's own address counter does it); INVON is
 * applied here, at scan-out, as real hardware does. Backlight or display off
 * dims it, exactly as the design shows.
 *
 * The message carries a `dirty` rect (physical GRAM coords) — a partial update
 * repaints only that region, not the whole canvas. A change of dimensions,
 * dim level or invert forces a full repaint.
 */
export function St7789Screen({
  framebuffer,
  zoom,
  rotate = 0
}: St7789ScreenProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<ImageData | null>(null)
  const stateRef = useRef({ dispW: 0, dispH: 0, dim: -1, inv: -1 })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !framebuffer) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const { width, height, madctl, pixels, displayOn, backlightOn, inverted } = framebuffer
    const mv = (madctl & MADCTL_MV) !== 0
    const inv = inverted ? 0xffff : 0x0000
    const dispW = mv ? height : width
    const dispH = mv ? width : height
    const dim = displayOn && backlightOn ? 1 : 0.14

    if (canvas.width !== dispW) canvas.width = dispW
    if (canvas.height !== dispH) canvas.height = dispH

    const s = stateRef.current
    const fullRepaint =
      !imageRef.current || s.dispW !== dispW || s.dispH !== dispH || s.dim !== dim || s.inv !== inv
    if (!imageRef.current || s.dispW !== dispW || s.dispH !== dispH) {
      imageRef.current = ctx.createImageData(dispW, dispH)
    }
    stateRef.current = { dispW, dispH, dim, inv }

    const gram = new Uint16Array(pixels)
    const buf = imageRef.current.data

    const r = fullRepaint
      ? { x0: 0, y0: 0, x1: dispW, y1: dispH }
      : displayDirtyRect(mv, dispW, dispH, framebuffer.dirty)
    const { x0: rx0, y0: ry0, x1: rx1, y1: ry1 } = r

    for (let dy = ry0; dy < ry1; dy++) {
      for (let dx = rx0; dx < rx1; dx++) {
        const gramCol = mv ? dy : dx
        const gramRow = mv ? dx : dy
        const rgb565 = (gram[gramRow * width + gramCol] ?? 0) ^ inv
        const r = ((rgb565 >> 11) & 0x1f) * 8.225
        const g = ((rgb565 >> 5) & 0x3f) * 4.047
        const b = (rgb565 & 0x1f) * 8.225
        const o = (dy * dispW + dx) * 4
        buf[o] = r * dim
        buf[o + 1] = g * dim
        buf[o + 2] = b * dim
        buf[o + 3] = 255
      }
    }
    if (rx1 > rx0 && ry1 > ry0) {
      ctx.putImageData(imageRef.current, 0, 0, rx0, ry0, rx1 - rx0, ry1 - ry0)
    }
  }, [framebuffer, zoom])

  const base = framebuffer
    ? (framebuffer.madctl & MADCTL_MV) !== 0
      ? { w: framebuffer.height, h: framebuffer.width }
      : { w: framebuffer.width, h: framebuffer.height }
    : { w: 320, h: 240 }

  const quarter = ((Math.round(rotate / 90) % 4) + 4) % 4
  const swap = quarter === 1 || quarter === 3
  const frame = {
    width: (swap ? base.h : base.w) * zoom,
    height: (swap ? base.w : base.h) * zoom
  }

  return (
    <div className="st7789">
      <div className="st7789__frame" style={frame}>
        <canvas
          ref={canvasRef}
          className="st7789__canvas"
          style={{
            width: base.w * zoom,
            height: base.h * zoom,
            transform: quarter ? `rotate(${quarter * 90}deg)` : undefined
          }}
          aria-label="ST7789 panel output"
        />
      </div>
      {!framebuffer && (
        <p className="st7789__idle">No frame yet — boot firmware that drives the panel.</p>
      )}
    </div>
  )
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
