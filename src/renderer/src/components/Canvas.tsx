import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { MAX_ZOOM, MIN_ZOOM, clamp, fitViewport } from '@shared/workspace'
import type { ViewportState, WorkspaceState } from '@shared/workspace'
import type { BoardDefinition, PartDefinition } from '@shared/board'
import './canvas.css'

const GRID_SPACING = 20
const ZOOM_STEP = 1.15

interface CanvasProps {
  board: BoardDefinition
  workspace: WorkspaceState
  onViewport: (viewport: ViewportState) => void
  onZoomAt: (zoom: number, origin: { x: number; y: number }) => void
  onSelectPart: (partId: string | null) => void
  /** Told the viewport size so the Fit command can be driven from the menu. */
  onMeasure: (size: { width: number; height: number }) => void
  /**
   * True once the persisted layout has been restored. Framing the board before
   * then would be undone the moment the saved viewport arrives.
   */
  ready: boolean
}

/** Nets are coloured by the bus they belong to; loose nets stay neutral. */
function netColour(busId: string | undefined, buses: BoardDefinition['buses']): string {
  const bus = buses.find((candidate) => candidate.id === busId)
  switch (bus?.kind) {
    case 'spi':
      return 'var(--accent-500)'
    case 'i2c':
      return 'var(--accent-2-500)'
    case 'uart':
      return 'var(--status-warn)'
    default:
      return 'var(--neutral-600)'
  }
}

const partCentre = (part: PartDefinition): { x: number; y: number } => ({
  x: part.layout.x + part.layout.width / 2,
  y: part.layout.y + part.layout.height / 2
})

export function Canvas({
  board,
  workspace,
  onViewport,
  onZoomAt,
  onSelectPart,
  onMeasure,
  ready
}: CanvasProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null)
  const spaceHeldRef = useRef(false)
  const { viewport, grid, tool } = workspace.canvas

  const measure = useCallback((): { width: number; height: number } => {
    const rect = hostRef.current?.getBoundingClientRect()
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 }
  }, [])

  // Report our size on every resize, so Fit works from the toolbar and the menu.
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    onMeasure(measure())
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => onMeasure(measure()))
    observer.observe(host)
    return () => observer.disconnect()
  }, [measure, onMeasure])

  // A pristine viewport means "never positioned": frame the board rather than
  // dropping the user at the origin.
  const framed = useRef(false)
  useLayoutEffect(() => {
    if (framed.current || !ready) return
    const size = measure()
    if (size.width === 0 || size.height === 0) return
    framed.current = true
    if (viewport.x === 0 && viewport.y === 0 && viewport.zoom === 1) {
      onViewport(fitViewport(board.canvas, size))
    }
  }, [board.canvas, measure, onViewport, ready, viewport])

  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.code === 'Space') spaceHeldRef.current = true
    }
    const up = (event: KeyboardEvent): void => {
      if (event.code === 'Space') spaceHeldRef.current = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  const onWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    const rect = hostRef.current?.getBoundingClientRect()
    if (!rect) return
    // Trackpad pinch arrives as a wheel event with ctrlKey set.
    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(-event.deltaY / 200)
      onZoomAt(clamp(viewport.zoom * factor, MIN_ZOOM, MAX_ZOOM), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      })
      return
    }
    onViewport({ ...viewport, x: viewport.x - event.deltaX, y: viewport.y - event.deltaY })
  }

  const panning = (event: React.PointerEvent): boolean =>
    tool === 'pan' || event.button === 1 || spaceHeldRef.current

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!panning(event)) return
    event.preventDefault()
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    onViewport({
      ...viewport,
      x: viewport.x + (event.clientX - drag.x),
      y: viewport.y + (event.clientY - drag.y)
    })
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const mcu = board.parts.find((part) => part.category === 'mcu')

  return (
    <div
      className="canvas"
      ref={hostRef}
      data-tool={tool}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={(event) => {
        if (event.target === event.currentTarget) onSelectPart(null)
      }}
      role="application"
      aria-label={`${board.name} diagram`}
    >
      <svg className="canvas__surface" width="100%" height="100%">
        <defs>
          <pattern
            id="grid-dot"
            width={GRID_SPACING * viewport.zoom}
            height={GRID_SPACING * viewport.zoom}
            patternUnits="userSpaceOnUse"
            x={viewport.x}
            y={viewport.y}
          >
            <circle cx={1} cy={1} r={1} fill="var(--border-strong)" />
          </pattern>
          <pattern
            id="grid-line"
            width={GRID_SPACING * viewport.zoom}
            height={GRID_SPACING * viewport.zoom}
            patternUnits="userSpaceOnUse"
            x={viewport.x}
            y={viewport.y}
          >
            <path
              d={`M ${GRID_SPACING * viewport.zoom} 0 L 0 0 0 ${GRID_SPACING * viewport.zoom}`}
              fill="none"
              stroke="var(--border-subtle)"
              strokeWidth={1}
            />
          </pattern>
        </defs>

        {grid !== 'none' && <rect width="100%" height="100%" fill={`url(#grid-${grid})`} />}

        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
          <rect
            className="canvas__outline"
            x={0}
            y={0}
            width={board.canvas.width}
            height={board.canvas.height}
            rx={12}
          />

          {mcu &&
            board.nets.map((net) => {
              const hub = partCentre(mcu)
              const colour = netColour(net.bus, board.buses)
              return net.nodes
                .filter((node) => node.includes(':'))
                .map((node) => {
                  const partId = node.split(':')[0] ?? ''
                  const part = board.parts.find((candidate) => candidate.id === partId)
                  if (!part) return null
                  const end = partCentre(part)
                  const midX = (hub.x + end.x) / 2
                  return (
                    <polyline
                      key={`${net.id}-${node}`}
                      className="canvas__net"
                      points={`${hub.x},${hub.y} ${midX},${hub.y} ${midX},${end.y} ${end.x},${end.y}`}
                      stroke={colour}
                    />
                  )
                })
            })}

          {board.parts.map((part) => {
            const selected = workspace.selectedPartId === part.id
            return (
              <g
                key={part.id}
                className="canvas__part"
                data-selected={selected || undefined}
                transform={`translate(${part.layout.x} ${part.layout.y})`}
                onClick={(event) => {
                  event.stopPropagation()
                  onSelectPart(part.id)
                }}
              >
                <rect
                  className="canvas__part-body"
                  width={part.layout.width}
                  height={part.layout.height}
                  rx={8}
                />
                <text className="canvas__part-designator" x={12} y={22}>
                  {part.designator}
                </text>
                <text className="canvas__part-name" x={12} y={40}>
                  {part.name}
                </text>
                <text className="canvas__part-meta" x={12} y={part.layout.height - 14}>
                  {part.pins.length} pins
                </text>
              </g>
            )
          })}
        </g>
      </svg>
    </div>
  )
}

export { ZOOM_STEP }
