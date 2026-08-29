import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MAX_ZOOM, MIN_ZOOM, clamp, fitViewport } from '@shared/workspace'
import type { ViewportState, WorkspaceState } from '@shared/workspace'
import { CATEGORY_LABELS, boardTotals } from '@shared/board'
import type { BoardDefinition, NetDefinition, PartCategory, PartDefinition } from '@shared/board'
import { netColour, netFilterKind } from '@shared/nets'
import './canvas.css'

const GRID_SPACING = 20
const ZOOM_STEP = 1.15

type CardTab = 'cfg' | 'in' | 'out'
const CARD_TABS: CardTab[] = ['cfg', 'in', 'out']

/** A glyph per part class for the node-card header. */
const CATEGORY_GLYPH: Record<PartCategory, string> = {
  mcu: '▦',
  radio: '((•))',
  display: '▢',
  storage: '▤',
  sensor: '◈',
  input: '⌨',
  power: '⚡',
  interface: '⇄'
}

interface CanvasProps {
  board: BoardDefinition
  workspace: WorkspaceState
  onViewport: (viewport: ViewportState) => void
  onZoomAt: (zoom: number, origin: { x: number; y: number }) => void
  onSelectPart: (partId: string | null) => void
  /** Commit a part drag (Select tool) — board-definition units. */
  onMovePart: (partId: string, x: number, y: number) => void
  /** Add a net between two parts (Draw-net tool). */
  onAddNet: (net: NetDefinition) => void
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
  onMovePart,
  onAddNet,
  onMeasure,
  ready
}: CanvasProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null)
  const spaceHeldRef = useRef(false)
  const { viewport, grid, tool, snapToGrid, busLabels, hiddenBuses } = workspace.canvas
  const [spiToastDismissed, setSpiToastDismissed] = useState(false)
  const [cardTabs, setCardTabs] = useState<Record<string, CardTab>>({})
  // Part drag (Select tool): live pixel offset while dragging, committed on drop.
  const [partDrag, setPartDrag] = useState<{
    partId: string
    pointerId: number
    startX: number
    startY: number
    dx: number
    dy: number
    moved: boolean
  } | null>(null)
  // Draw-net tool: the first part clicked, awaiting a second. Only meaningful
  // while the net tool is active.
  const [netFromRaw, setNetFrom] = useState<string | null>(null)
  const netFrom = tool === 'net' ? netFromRaw : null
  const sharedSpi = sharedSpiBuses(board)
  const totals = boardTotals(board)

  const snap = useCallback(
    (value: number): number => (snapToGrid ? Math.round(value / 10) * 10 : Math.round(value)),
    [snapToGrid]
  )

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

  // Net geometry, with label positions resolved once so that labels which would
  // land on the same spot (e.g. every leg of one SPI bus ends at the same
  // peripheral) stack upward instead of overprinting.
  const netGeometry = (() => {
    if (!mcu) return []
    const hub = partCentre(mcu)
    const placed: { x: number; y: number }[] = []
    return board.nets.flatMap((net) => {
      const ends = net.nodes
        .filter((node) => node.includes(':'))
        .map((node) => {
          const partId = node.split(':')[0] ?? ''
          const part = board.parts.find((candidate) => candidate.id === partId)
          return part ? { node, end: partCentre(part) } : null
        })
        .filter((e): e is { node: string; end: { x: number; y: number } } => e !== null)
      if (ends.length === 0) return []
      const filterKind = netFilterKind(net.bus, board.buses)
      const dimmed = filterKind !== null && hiddenBuses.includes(filterKind)
      const furthest = ends.reduce((a, b) =>
        Math.abs(b.end.x - hub.x) > Math.abs(a.end.x - hub.x) ? b : a
      )
      const labelX = (hub.x + furthest.end.x) / 2
      let labelY = furthest.end.y - 8
      if (!dimmed) {
        while (placed.some((p) => Math.abs(p.x - labelX) < 90 && Math.abs(p.y - labelY) < 16)) {
          labelY -= 18
        }
        placed.push({ x: labelX, y: labelY })
      }
      return [
        {
          net,
          hub,
          ends,
          dimmed,
          colour: netColour(net.bus, board.buses),
          labelX,
          labelY
        }
      ]
    })
  })()

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

          {netGeometry.map(({ net, hub, ends, dimmed, colour, labelX, labelY }) => (
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
          ))}

          {board.parts.map((part) => {
            const selected = workspace.selectedPartId === part.id
            const tab: CardTab = cardTabs[part.id] ?? 'cfg'
            const partBuses = part.buses
              .map((id) => board.buses.find((bus) => bus.id === id)?.label ?? id)
              .join(', ')
            const dragging = partDrag?.partId === part.id
            const tx = part.layout.x + (dragging ? partDrag.dx / viewport.zoom : 0)
            const ty = part.layout.y + (dragging ? partDrag.dy / viewport.zoom : 0)
            const handleCardClick = (event: React.MouseEvent): void => {
              event.stopPropagation()
              if (tool === 'net') {
                if (!netFrom) {
                  setNetFrom(part.id)
                } else if (netFrom !== part.id) {
                  const from = board.parts.find((p) => p.id === netFrom)
                  onAddNet({
                    id: `net-${netFrom}-${part.id}-${Date.now().toString(36)}`,
                    label: `${from?.designator ?? netFrom}–${part.designator}`,
                    nodes: [
                      `${netFrom}:${from?.pins[0]?.signal ?? 'NET'}`,
                      `${part.id}:${part.pins[0]?.signal ?? 'NET'}`
                    ]
                  })
                  setNetFrom(null)
                }
                return
              }
              onSelectPart(part.id)
            }
            return (
              <g
                key={part.id}
                className="canvas__part"
                data-selected={selected || undefined}
                data-net-from={netFrom === part.id || undefined}
                transform={`translate(${tx} ${ty})`}
              >
                <foreignObject width={part.layout.width} height={part.layout.height}>
                  <div
                    className="canvas__card"
                    data-selected={selected || undefined}
                    data-draggable={tool === 'select' || undefined}
                    onClick={handleCardClick}
                    onPointerDown={(event) => {
                      if (tool !== 'select' || event.button !== 0) return
                      event.stopPropagation()
                      ;(event.target as Element).setPointerCapture?.(event.pointerId)
                      setPartDrag({
                        partId: part.id,
                        pointerId: event.pointerId,
                        startX: event.clientX,
                        startY: event.clientY,
                        dx: 0,
                        dy: 0,
                        moved: false
                      })
                    }}
                    onPointerMove={(event) => {
                      setPartDrag((d) => {
                        if (!d || d.pointerId !== event.pointerId) return d
                        const dx = event.clientX - d.startX
                        const dy = event.clientY - d.startY
                        return {
                          ...d,
                          dx,
                          dy,
                          moved: d.moved || Math.hypot(dx, dy) > 3
                        }
                      })
                    }}
                    onPointerUp={(event) => {
                      setPartDrag((d) => {
                        if (!d || d.pointerId !== event.pointerId) return d
                        if (d.moved) {
                          onMovePart(
                            part.id,
                            snap(part.layout.x + d.dx / viewport.zoom),
                            snap(part.layout.y + d.dy / viewport.zoom)
                          )
                        }
                        return null
                      })
                    }}
                    onPointerCancel={() => setPartDrag(null)}
                  >
                    <div className="canvas__card-head">
                      <span className="canvas__card-glyph" aria-hidden="true">
                        {CATEGORY_GLYPH[part.category]}
                      </span>
                      <span className="canvas__card-title">
                        <span className="canvas__card-designator">{part.designator}</span>
                        <span className="canvas__card-name">{part.name}</span>
                      </span>
                      <span className="canvas__card-badge">{CATEGORY_LABELS[part.category]}</span>
                    </div>
                    <div className="canvas__card-strip" role="tablist">
                      {CARD_TABS.map((id) => (
                        <button
                          key={id}
                          type="button"
                          role="tab"
                          className="canvas__card-tab"
                          aria-selected={tab === id}
                          data-active={tab === id || undefined}
                          onClick={(event) => {
                            event.stopPropagation()
                            onSelectPart(part.id)
                            setCardTabs((previous) => ({ ...previous, [part.id]: id }))
                          }}
                        >
                          {id.toUpperCase()}
                        </button>
                      ))}
                    </div>
                    <div className="canvas__card-body">
                      {tab === 'cfg' && (
                        <ul className="canvas__card-pins">
                          {part.pins.length === 0 && <li className="canvas__card-dim">No pins</li>}
                          {part.pins.slice(0, 6).map((binding) => (
                            <li key={binding.signal}>
                              <span>{binding.signal}</span>
                              <span className="canvas__card-pin">{binding.pin}</span>
                            </li>
                          ))}
                          {part.pins.length > 6 && (
                            <li className="canvas__card-dim">+{part.pins.length - 6} more</li>
                          )}
                        </ul>
                      )}
                      {tab === 'in' && (
                        <p className="canvas__card-note">
                          {part.deviceModel
                            ? 'Stimuli available in the Inspector IN panel.'
                            : 'No stimuli for this part.'}
                        </p>
                      )}
                      {tab === 'out' && (
                        <p className="canvas__card-note">
                          {part.pins.length} pins
                          {partBuses ? ` · ${partBuses}` : ''}
                        </p>
                      )}
                    </div>
                  </div>
                </foreignObject>
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
