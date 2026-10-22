import { useEffect, useRef } from 'react'
import type { BoardDefinition, PartDefinition } from '@shared/board'
import type { DeviceFramebufferMessage } from '@shared/devices/messages'

interface St7789ScreenProps {
  framebuffer: DeviceFramebufferMessage | undefined
  /** Panel-zoom from the Inspector: `1`, `2` or `3`. */
  zoom: number
  /** Viewer rotation applied on top of the firmware's own MADCTL, in degrees:
      `0`, `90`, `180` or `270`. Purely a CSS transform on scan-out. */
  rotate?: number
  /** Round glass (the GC9A01): mask the square GRAM to a circle. */
  round?: boolean
  /**
   * Make the panel touchable: pointer down / drag / up on the picture, in
   * panel display coordinates (pre-rotation, so they match the touch
   * controller's axes). Omit for a panel with no touch layer.
   */
  onTouch?: (phase: 'down' | 'move' | 'up', x: number, y: number) => void
}

/** Touch-controller models a panel click can drive. */
const TOUCH_MODELS = new Set(['hynitron.cst816s'])

/** The board's touch controller part, if it has one (the CST816S on the Waveshare C6). */
export function touchControllerFor(board: BoardDefinition): PartDefinition | undefined {
  return board.parts.find((p) => p.deviceModel !== undefined && TOUCH_MODELS.has(p.deviceModel))
}

/** Don't flood the touch model with drag reports: one per this many ms. */
const TOUCH_MOVE_MS = 40

const MADCTL_MV = 0x20

/** Device models whose frames are RGB565 GRAM drawn by {@link St7789Screen}. */
export function isRgbPanel(model: string | undefined): boolean {
  return model === 'sitronix.st7789' || model === 'galaxycore.gc9a01'
}

/** RGB panels whose glass is round — the square GRAM's corners are never seen. */
export function isRoundPanel(model: string | undefined): boolean {
  return model === 'galaxycore.gc9a01'
}

/**
 * The panel's display-space dimensions (px), MADCTL MV transpose applied. This
 * is the box `St7789Screen` renders at `zoom === 1`; callers that scale the
 * panel to fit a container divide their box by it. Falls back to the M9
 * landscape default (or a square, for a round panel) before the first frame.
 */
export function panelBase(
  framebuffer: DeviceFramebufferMessage | undefined,
  round = false
): {
  w: number
  h: number
} {
  // Before the first frame: the round GC9A01 is 240×240, else the M9 landscape.
  if (!framebuffer) return round ? { w: 240, h: 240 } : { w: 320, h: 240 }
  return (framebuffer.madctl & MADCTL_MV) !== 0
    ? { w: framebuffer.height, h: framebuffer.width }
    : { w: framebuffer.width, h: framebuffer.height }
}

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
  rotate = 0,
  round = false,
  onTouch
}: St7789ScreenProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const touchRef = useRef({ down: false, lastMove: 0 })
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

    const gram =
      pixels instanceof ArrayBuffer
        ? new Uint16Array(pixels)
        : ArrayBuffer.isView(pixels)
          ? new Uint16Array(
              (pixels as ArrayBufferView).buffer,
              (pixels as ArrayBufferView).byteOffset,
              (pixels as ArrayBufferView).byteLength / 2
            )
          : new Uint16Array(pixels as unknown as ArrayLike<number>)
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

  const base = panelBase(framebuffer, round)

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
          className={[
            'st7789__canvas',
            round ? 'st7789__canvas--round' : '',
            onTouch ? 'st7789__canvas--touch' : ''
          ]
            .filter(Boolean)
            .join(' ')}
          {...(onTouch
            ? {
                onPointerDown: (event: React.PointerEvent<HTMLCanvasElement>) => {
                  event.stopPropagation()
                  event.currentTarget.setPointerCapture(event.pointerId)
                  touchRef.current = { down: true, lastMove: event.timeStamp }
                  onTouch('down', ...touchPoint(event, zoom))
                },
                onPointerMove: (event: React.PointerEvent<HTMLCanvasElement>) => {
                  const t = touchRef.current
                  if (!t.down || event.timeStamp - t.lastMove < TOUCH_MOVE_MS) return
                  t.lastMove = event.timeStamp
                  onTouch('move', ...touchPoint(event, zoom))
                },
                onPointerUp: (event: React.PointerEvent<HTMLCanvasElement>) => {
                  if (!touchRef.current.down) return
                  touchRef.current.down = false
                  onTouch('up', ...touchPoint(event, zoom))
                }
              }
            : {})}
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

/**
 * A pointer event's position in panel display pixels. `offsetX/Y` are in the
 * canvas's own (pre-CSS-transform) box, so the viewer's rotation is already
 * undone; dividing by the zoom gives framebuffer pixels.
 */
function touchPoint(event: React.PointerEvent<HTMLCanvasElement>, zoom: number): [number, number] {
  const z = zoom > 0 ? zoom : 1
  return [Math.round(event.nativeEvent.offsetX / z), Math.round(event.nativeEvent.offsetY / z)]
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
