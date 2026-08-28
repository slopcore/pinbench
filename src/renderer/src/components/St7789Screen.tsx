import { useEffect, useRef } from 'react'
import type { DeviceFramebufferMessage } from '@shared/devices/messages'

interface St7789ScreenProps {
  framebuffer: DeviceFramebufferMessage | undefined
  /** Panel-zoom from the Inspector: `1`, `2` or `3`. */
  zoom: number
}

const MADCTL_MV = 0x20

/**
 * The ST7789's OUT-panel picture: the GRAM the model accumulated from real
 * `RAMWR` traffic, drawn at native resolution and CSS-scaled to the chosen
 * zoom. `MADCTL`'s MV bit transposes GRAM to the landscape the M9 firmware
 * runs in (MX/MY are already baked into GRAM addresses by the model, the way
 * the panel's own address counter does it). Backlight or display off dims it,
 * exactly as the design shows.
 */
export function St7789Screen({ framebuffer, zoom }: St7789ScreenProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !framebuffer) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const { width, height, madctl, pixels, displayOn, backlightOn } = framebuffer
    const mv = (madctl & MADCTL_MV) !== 0
    const dispW = mv ? height : width
    const dispH = mv ? width : height
    if (canvas.width !== dispW) canvas.width = dispW
    if (canvas.height !== dispH) canvas.height = dispH

    const gram = new Uint16Array(pixels)
    const image = ctx.createImageData(dispW, dispH)
    const buf = image.data
    const dim = displayOn && backlightOn ? 1 : 0.14

    for (let dy = 0; dy < dispH; dy++) {
      for (let dx = 0; dx < dispW; dx++) {
        const gramCol = mv ? dy : dx
        const gramRow = mv ? dx : dy
        const rgb565 = gram[gramRow * width + gramCol] ?? 0
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
    ctx.putImageData(image, 0, 0)
  }, [framebuffer, zoom])

  const base = framebuffer
    ? (framebuffer.madctl & MADCTL_MV) !== 0
      ? { w: framebuffer.height, h: framebuffer.width }
      : { w: framebuffer.width, h: framebuffer.height }
    : { w: 320, h: 240 }

  return (
    <div className="st7789">
      <canvas
        ref={canvasRef}
        className="st7789__canvas"
        style={{ width: base.w * zoom, height: base.h * zoom }}
        aria-label="ST7789 panel output"
      />
      {!framebuffer && (
        <p className="st7789__idle">No frame yet — boot firmware that drives the panel.</p>
      )}
    </div>
  )
}
