import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MAX_ZOOM, MIN_ZOOM, clamp, fitViewport } from '@shared/workspace'
import type { ViewportState, WorkspaceState } from '@shared/workspace'
import { boardTotals } from '@shared/board'
import type { BoardDefinition, PartDefinition } from '@shared/board'
import { netColour, netFilterKind } from '@shared/nets'
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

/** SPI buses carrying more than one peripheral — the "Shared SPI bus" notice. */
function sharedSpiBuses(board: BoardDefinition): string[] {
  return board.buses
    .filter((bus) => bus.kind === 'spi')
    .filter((bus) => board.parts.filter((part) => part.buses.includes(bus.id)).length > 1)
    .map((bus) => bus.label)
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
  const { viewport, grid, tool, busLabels, hiddenBuses } = workspace.canvas
  const [spiToastDismissed, setSpiToastDismissed] = useState(false)
  const sharedSpi = sharedSpiBuses(board)
  const totals = boardTotals(board)

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
              const filterKind = netFilterKind(net.bus, board.buses)
              const dimmed = filterKind !== null && hiddenBuses.includes(filterKind)
              const ends = net.nodes
                .filter((node) => node.includes(':'))
                .map((node) => {
                  const partId = node.split(':')[0] ?? ''
                  const part = board.parts.find((candidate) => candidate.id === partId)
                  return part ? { node, end: partCentre(part) } : null
                })
                .filter(
                  (entry): entry is { node: string; end: { x: number; y: number } } =>
                    entry !== null
                )
              if (ends.length === 0) return null
              // Put the label on the leg to the furthest peripheral, so it sits
              // clear of the MCU card.
              const furthest = ends.reduce((a, b) =>
                Math.abs(b.end.x - hub.x) > Math.abs(a.end.x - hub.x) ? b : a
              )
              const labelX = (hub.x + furthest.end.x) / 2
              const labelY = furthest.end.y - 8
              return (
                <g key={net.id} className="canvas__net-group" data-dimmed={dimmed || undefined}>
                  {ends.map(({ node, end }) => {
                    const midX = (hub.x + end.x) / 2
                    return (
                      <polyline
                        key={`${net.id}-${node}`}
                        className="canvas__net"
                        points={`${hub.x},${hub.y} ${midX},${hub.y} ${midX},${end.y} ${end.x},${end.y}`}
                        stroke={colour}
                      />
                    )
                  })}
                  {busLabels && !dimmed && (
                    <g className="canvas__net-label" transform={`translate(${labelX} ${labelY})`}>
                      <rect
                        className="canvas__net-label-box"
                        x={-net.label.length * 3.4 - 6}
                        y={-9}
                        width={net.label.length * 6.8 + 12}
                        height={16}
                        rx={8}
                      />
                      <text className="canvas__net-label-text" x={0} y={2} textAnchor="middle">
                        {net.label}
                      </text>
                    </g>
                  )}
                </g>
              )
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

      <div className="canvas__stats" aria-label="Diagram totals">
        {totals.parts} parts · {totals.nets} nets · {totals.assignedGpio} GPIO assigned
      </div>

      {sharedSpi.length > 0 && !spiToastDismissed && (
        <div className="canvas__toast" role="status">
          <span className="canvas__toast-text">
            Shared SPI bus — {sharedSpi.join(', ')} carries more than one peripheral
          </span>
          <button
            type="button"
            className="canvas__toast-dismiss"
            aria-label="Dismiss"
            onClick={() => setSpiToastDismissed(true)}
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
}

export { ZOOM_STEP }
