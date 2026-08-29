import { useEffect, useRef } from 'react'
import type { DeviceFramebufferMessage } from '@shared/devices/messages'

interface EInkScreenProps {
  framebuffer: DeviceFramebufferMessage | undefined
  /** Panel-zoom from the Inspector: `1`, `2` or `3`. */
  zoom: number
}

// E-paper isn't pure black/white: unset "ink" sits on a warm grey substrate,
// set ink is a soft near-black. Matching the design's e-ink swatches.
const PAPER: [number, number, number] = [0xdf, 0xdd, 0xd4]
const INK: [number, number, number] = [0x24, 0x24, 0x28]

/**
 * The Heltec e-paper's OUT-panel picture. The model hands over the panel's BW
 * RAM the moment `MASTER_ACTIVATION` latched it — a packed 1bpp buffer, bit set
 * = white, `ceil(width / 8)` bytes per row. Unlike the ST7789 there is no
 * rotation to undo here: the guest drew straight into RAM in whatever
 * orientation its driver chose, and e-ink has no backlight or invert to model.
 * The whole panel repaints on every message (an e-ink refresh is a whole-panel
 * event) so there is no dirty-rect fast path.
 */
export function EInkScreen({ framebuffer, zoom }: EInkScreenProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !framebuffer || framebuffer.format !== 'mono1') return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const { width, height, pixels } = framebuffer
    const bytesPerRow = Math.ceil(width / 8)
    const bits = new Uint8Array(pixels)

    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    const image = ctx.createImageData(width, height)
    const buf = image.data

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const byte = bits[y * bytesPerRow + (x >> 3)] ?? 0xff
        const white = (byte & (0x80 >> (x & 7))) !== 0
        const [r, g, b] = white ? PAPER : INK
        const o = (y * width + x) * 4
        buf[o] = r
        buf[o + 1] = g
        buf[o + 2] = b
        buf[o + 3] = 255
      }
    }
    ctx.putImageData(image, 0, 0)
  }, [framebuffer])

  const base = framebuffer
    ? { w: framebuffer.width, h: framebuffer.height }
    : { w: 250, h: 122 }

  return (
    <div className="eink">
      <canvas
        ref={canvasRef}
        className="eink__canvas"
        style={{ width: base.w * zoom, height: base.h * zoom }}
        aria-label="E-paper panel output"
      />
      {!framebuffer && (
        <p className="eink__idle">No frame yet — boot firmware that refreshes the panel.</p>
      )}
    </div>
  )
}
