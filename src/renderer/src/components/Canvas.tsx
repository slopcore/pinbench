import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MAX_ZOOM, MIN_ZOOM, clamp, fitViewport } from '@shared/workspace'
import type { ViewportState, WorkspaceState } from '@shared/workspace'
import { CATEGORY_LABELS, boardTotals } from '@shared/board'
import type { BoardDefinition, NetDefinition, PartCategory, PartDefinition } from '@shared/board'
import { netColour, netFilterKind } from '@shared/nets'
import type { PartConfigValue } from '@shared/partConfig'
import type { PartDeviceView } from '../state/useDevices'
import {
  St7789Screen,
  isRgbPanel,
  isRoundPanel,
  panelBase,
  touchControllerFor
} from './St7789Screen'
import { EInkScreen, einkBase } from './EInkScreen'
import { OutPanel, fieldValue, panelRotate } from './OutPanel'
import { InPanel } from './InPanel'
import './canvas.css'

const GRID_SPACING = 20
const ZOOM_STEP = 1.15

/** Smallest a card may be dragged to by the corner resize handle (board units). */
const MIN_CARD_W = 120
const MIN_CARD_H = 90
/** Card chrome (head + tab strip + rotation control + padding) subtracted from
    the card box for the first-paint / jsdom estimate of the screen box. The
    real box is measured from the DOM once laid out. */
const CARD_PAD_W = 24
const CARD_CHROME_H = 88

type CardTab = 'cfg' | 'in' | 'out'
const CARD_TABS: CardTab[] = ['cfg', 'in', 'out']

/** Which screen renderer, if any, a part's device model maps to. */
function screenKind(model: string | undefined): 'st7789' | 'eink' | null {
  if (isRgbPanel(model)) return 'st7789'
  if (model === 'ultrachip.uc8151') return 'eink'
  return null
}

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
  /** Commit a card resize (Select tool) — board-definition units. */
  onResizePart?: (partId: string, width: number, height: number) => void
  /** Live device views keyed by part id — the OUT-tab screen picture reads its
      framebuffer from here. */
  deviceViews?: Map<string, PartDeviceView>
  /** Live Inspector config values, keyed `partId.fieldId` — the OUT-tab rotation
      control reads and writes them. */
  configValues?: Record<string, PartConfigValue>
  /** Commit a config-field change (part-scoped) — the Inspector's `onConfigChange`. */
  onConfigChange?: (partId: string, fieldId: string, value: PartConfigValue) => void
  /** Send a device-model command from a node card's IN tab — the Inspector's `onCommand`. */
  onCommand?: (partId: string, command: string, args?: Record<string, unknown>) => void
  /** Told the viewport size so the Fit command can be driven from the menu. */
  onMeasure: (size: { width: number; height: number }) => void
  /**
   * True once the persisted layout has been restored. Framing the board before
   * then would be undone the moment the saved viewport arrives.
   */
  ready: boolean
}

const partCentre = (part: PartDefinition): { x: number; y: number } => ({
  x: part.layout.x + part.layout.width / 2,
  y: part.layout.y + part.layout.height / 2
})

function defaultTab(part: PartDefinition): CardTab {
  if (part.category === 'display') return 'out'
  if (part.category === 'input') return 'in'
  if (part.deviceModel === 'pinbench.led') return 'out'
  return 'cfg'
}

export function Canvas({
  board,
  workspace,
  onViewport,
  onZoomAt,
  onSelectPart,
  onMovePart,
  onAddNet,
  onResizePart,
  deviceViews,
  configValues,
  onConfigChange,
  onCommand,
  onMeasure,
  ready
}: CanvasProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null)
  const spaceHeldRef = useRef(false)
  const { viewport, grid, tool, snapToGrid, busLabels, hiddenBuses } = workspace.canvas
  const [cardTabs, setCardTabs] = useState<Record<string, CardTab>>({})
  // Part drag (Select tool): live pixel offset while dragging, committed on drop.
  const [partDrag, setPartDrag] = useState<{
    partId: string
    dx: number
    dy: number
    moved: boolean
  } | null>(null)
  // Card resize (Select tool): live pixel delta from the corner handle,
  // committed to the board on drop.
  const [partResize, setPartResize] = useState<{
    partId: string
    dx: number
    dy: number
  } | null>(null)

  // The active card gesture. Held in a ref (not state) so the window listeners
  // installed below never need to re-bind mid-drag, and so the drag survives the
  // card subtree re-rendering under the pointer. Pointer *capture* is deliberately
  // not used: the handle/card live inside an SVG `foreignObject` and get replaced
  // on every frame of the drag, which silently drops capture and strands the
  // gesture "on".
  const gestureRef = useRef<{
    mode: 'move' | 'resize'
    partId: string
    pointerId: number
    startX: number
    startY: number
    origX: number
    origY: number
    origW: number
    origH: number
  } | null>(null)
  // Latest values the commit needs, read at drop time without re-binding listeners.
  const commitRef = useRef({ zoom: 1, snap: (n: number) => n, onMovePart, onResizePart })
  // Draw-net tool: the first part clicked, awaiting a second. Only meaningful
  // while the net tool is active.
  const [netFromRaw, setNetFrom] = useState<string | null>(null)
  const netFrom = tool === 'net' ? netFromRaw : null
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

  useEffect(() => {
    commitRef.current = { zoom: viewport.zoom, snap, onMovePart, onResizePart }
  })

  // Card move / resize: the pointerdown handlers seed `gestureRef` and the live
  // preview state; the move and drop are tracked on `window` so the gesture is
  // immune to the pointer leaving the handle, to capture loss, and to the card
  // unmounting. `gestureMode` toggling non-null is what arms these listeners.
  const gestureMode = partResize ? 'resize' : partDrag ? 'move' : null
  useEffect(() => {
    if (!gestureMode) return
    const onMove = (event: PointerEvent): void => {
      const g = gestureRef.current
      if (!g || event.pointerId !== g.pointerId) return
      const dx = event.clientX - g.startX
      const dy = event.clientY - g.startY
      if (g.mode === 'resize') {
        setPartResize({ partId: g.partId, dx, dy })
      } else {
        setPartDrag((d) => ({
          partId: g.partId,
          dx,
          dy,
          moved: (d?.moved ?? false) || Math.hypot(dx, dy) > 3
        }))
      }
    }
    const onUp = (event: PointerEvent): void => {
      const g = gestureRef.current
      if (!g || event.pointerId !== g.pointerId) return
      gestureRef.current = null
      const dx = event.clientX - g.startX
      const dy = event.clientY - g.startY
      const { zoom, snap, onMovePart, onResizePart } = commitRef.current
      if (g.mode === 'resize') {
        onResizePart?.(
          g.partId,
          snap(Math.max(MIN_CARD_W, g.origW + dx / zoom)),
          snap(Math.max(MIN_CARD_H, g.origH + dy / zoom))
        )
        setPartResize(null)
      } else {
        if (Math.hypot(dx, dy) > 3) {
          onMovePart(g.partId, snap(g.origX + dx / zoom), snap(g.origY + dy / zoom))
        }
        setPartDrag(null)
      }
    }
    const onCancel = (): void => {
      gestureRef.current = null
      setPartDrag(null)
      setPartResize(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [gestureMode])

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
  // Clicking an RGB panel drives the board's touch controller, if it has one.
  const touchPart = touchControllerFor(board)
  const panelTouch = (
    part: PartDefinition
  ): ((phase: 'down' | 'move' | 'up', x: number, y: number) => void) | undefined =>
    touchPart && onCommand && isRgbPanel(part.deviceModel)
      ? (phase, x, y) => onCommand(touchPart.id, phase === 'up' ? 'release' : 'touch', { x, y })
      : undefined

  // Net geometry, with label positions resolved once so that labels which would
  // land on the same spot (e.g. every leg of one SPI bus ends at the same
  // peripheral) stack upward instead of overprinting.
  const netGeometry = useMemo(() => {
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
  }, [board.parts, board.nets, board.buses, hiddenBuses, mcu])

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
      aria-label={`${board.name} hardware`}
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
            const tab: CardTab = cardTabs[part.id] ?? defaultTab(part)
            const partBuses = part.buses
              .map((id) => board.buses.find((bus) => bus.id === id)?.label ?? id)
              .join(', ')
            const dragging = partDrag?.partId === part.id
            const tx = part.layout.x + (dragging ? partDrag.dx / viewport.zoom : 0)
            const ty = part.layout.y + (dragging ? partDrag.dy / viewport.zoom : 0)
            const resizing = partResize?.partId === part.id
            const liveW = Math.max(
              MIN_CARD_W,
              part.layout.width + (resizing ? partResize.dx / viewport.zoom : 0)
            )
            const liveH = Math.max(
              MIN_CARD_H,
              part.layout.height + (resizing ? partResize.dy / viewport.zoom : 0)
            )
            const kind = screenKind(part.deviceModel)
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
                <foreignObject width={liveW} height={liveH}>
                  <div
                    className="canvas__card"
                    data-selected={selected || undefined}
                    data-draggable={tool === 'select' || undefined}
                    onClick={handleCardClick}
                    onPointerDown={(event) => {
                      if (tool !== 'select' || event.button !== 0) return
                      const target = event.target as HTMLElement | null
                      if (
                        target &&
                        (target.closest('button') ||
                          target.closest('input') ||
                          target.closest('select') ||
                          target.closest('textarea') ||
                          target.closest('.canvas__card-strip') ||
                          target.closest('.canvas__card-in') ||
                          target.closest('.canvas__card-screen') ||
                          target.closest('.outpanel') ||
                          target.closest('.kbd'))
                      ) {
                        return
                      }
                      event.stopPropagation()
                      gestureRef.current = {
                        mode: 'move',
                        partId: part.id,
                        pointerId: event.pointerId,
                        startX: event.clientX,
                        startY: event.clientY,
                        origX: part.layout.x,
                        origY: part.layout.y,
                        origW: part.layout.width,
                        origH: part.layout.height
                      }
                      setPartDrag({ partId: part.id, dx: 0, dy: 0, moved: false })
                    }}
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
                    <div
                      className="canvas__card-strip"
                      role="tablist"
                      onPointerDown={(event) => event.stopPropagation()}
                    >
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
                    <div
                      className="canvas__card-body"
                      onPointerDown={(event) => {
                        const target = event.target as HTMLElement | null
                        if (
                          target?.closest('button') ||
                          target?.closest('input') ||
                          target?.closest('select')
                        ) {
                          event.stopPropagation()
                        }
                      }}
                    >
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
                      {tab === 'in' &&
                        (part.deviceModel && onCommand ? (
                          <div
                            className="canvas__card-in"
                            onPointerDown={(event) => event.stopPropagation()}
                          >
                            <InPanel
                              part={part}
                              onCommand={(command, args) => onCommand(part.id, command, args)}
                            />
                          </div>
                        ) : (
                          <p className="canvas__card-note">
                            {part.deviceModel
                              ? 'Stimuli available in the Inspector IN panel.'
                              : 'No stimuli for this part.'}
                          </p>
                        ))}
                      {tab === 'out' &&
                        (kind ? (
                          <ScreenCard
                            part={part}
                            kind={kind}
                            view={deviceViews?.get(part.id)}
                            configValues={configValues}
                            availW={liveW - CARD_PAD_W}
                            availH={liveH - CARD_CHROME_H}
                            onConfigChange={onConfigChange}
                            onSelectPart={onSelectPart}
                            onTouch={panelTouch(part)}
                          />
                        ) : part.deviceModel ? (
                          <div
                            className="canvas__card-out"
                            onPointerDown={(event) => event.stopPropagation()}
                          >
                            <OutPanel
                              part={part}
                              view={deviceViews?.get(part.id)}
                              configValues={configValues}
                              onConfigChange={(fieldId: string, value: PartConfigValue) =>
                                onConfigChange?.(part.id, fieldId, value)
                              }
                            />
                          </div>
                        ) : (
                          <p className="canvas__card-note">
                            {part.pins.length} pins
                            {partBuses ? ` · ${partBuses}` : ''}
                          </p>
                        ))}
                    </div>
                    {onResizePart && tool === 'select' && (
                      <span
                        className="canvas__card-resize"
                        aria-hidden="true"
                        onClick={(event) => event.stopPropagation()}
                        onPointerDown={(event) => {
                          if (event.button !== 0) return
                          event.stopPropagation()
                          gestureRef.current = {
                            mode: 'resize',
                            partId: part.id,
                            pointerId: event.pointerId,
                            startX: event.clientX,
                            startY: event.clientY,
                            origX: part.layout.x,
                            origY: part.layout.y,
                            origW: part.layout.width,
                            origH: part.layout.height
                          }
                          setPartResize({ partId: part.id, dx: 0, dy: 0 })
                        }}
                      />
                    )}
                  </div>
                </foreignObject>
              </g>
            )
          })}
        </g>
      </svg>

      <div className="canvas__stats" aria-label="Hardware totals">
        {totals.parts} parts · {totals.nets} nets · {totals.assignedGpio} GPIO assigned
      </div>
    </div>
  )
}

export { ZOOM_STEP }

/**
 * The OUT-tab picture for a screen part: the same live panel render as the
 * Inspector's OUT panel, plus its Rotation control, scaled to fill whatever box
 * the (resizable) card gives it. Every rotation click goes through the
 * Inspector's `onConfigChange`, so the card and the Inspector stay in lock-step.
 */
function ScreenCard({
  part,
  kind,
  view,
  configValues,
  availW,
  availH,
  onConfigChange,
  onSelectPart,
  onTouch
}: {
  part: PartDefinition
  kind: 'st7789' | 'eink'
  view: PartDeviceView | undefined
  configValues: Record<string, PartConfigValue> | undefined
  availW: number
  availH: number
  onConfigChange: ((partId: string, fieldId: string, value: PartConfigValue) => void) | undefined
  onSelectPart: (partId: string | null) => void
  onTouch: ((phase: 'down' | 'move' | 'up', x: number, y: number) => void) | undefined
}): React.JSX.Element {
  const framebuffer = view?.framebuffer
  const rotate = panelRotate(part, configValues)
  const base =
    kind === 'st7789'
      ? panelBase(framebuffer, isRoundPanel(part.deviceModel))
      : einkBase(framebuffer)
  const quarter = ((Math.round(rotate / 90) % 4) + 4) % 4
  const swap = quarter === 1 || quarter === 3
  const drawW = swap ? base.h : base.w
  const drawH = swap ? base.w : base.h

  // Fit the panel into the box the card gives us. `availW`/`availH` are derived
  // from the live card size, so this recomputes on every frame of a resize
  // drag. (A ResizeObserver on the view element does not fire reliably for HTML
  // nested in an SVG `foreignObject`, so it would freeze the picture instead.)
  const zoom = clamp(Math.min(Math.max(availW, 1) / drawW, Math.max(availH, 1) / drawH), 0.1, 8)

  const rotation = part.config.find((f) => f.id === 'rotation')
  const rotationValue = fieldValue(part, configValues, 'rotation')

  return (
    <div className="canvas__card-screen">
      {rotation?.kind === 'segmented' && onConfigChange && (
        <div
          className="field__segmented canvas__card-rotate"
          role="group"
          aria-label="Rotation"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {rotation.options.map((option) => (
            <button
              key={option}
              type="button"
              className="field__segment"
              aria-pressed={rotationValue === option}
              data-active={rotationValue === option || undefined}
              onClick={() => {
                onSelectPart(part.id)
                onConfigChange(part.id, 'rotation', option)
              }}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <div className="canvas__card-screen-view">
        {kind === 'st7789' ? (
          <St7789Screen
            framebuffer={framebuffer}
            zoom={zoom}
            rotate={rotate}
            round={isRoundPanel(part.deviceModel)}
            {...(onTouch ? { onTouch } : {})}
          />
        ) : (
          <EInkScreen framebuffer={framebuffer} zoom={zoom} rotate={rotate} />
        )}
      </div>
    </div>
  )
}
