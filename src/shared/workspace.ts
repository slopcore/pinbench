/**
 * Workspace layout state: everything the window remembers across a restart.
 *
 * Kept as a plain serialisable object with a pure reducer so both the renderer
 * and the persistence layer in the main process agree on its shape, and so the
 * layout rules are unit-testable without a window.
 */

export type DockTab = 'serial' | 'compiler' | 'console' | 'actions' | 'agent'
export type GridStyle = 'dot' | 'line' | 'none'
export type CanvasTool = 'select' | 'pan' | 'net' | 'probe'
/** Bus kinds the toolbar filter chips can dim on the canvas. */
export type BusFilterKind = 'spi' | 'i2c' | 'uart' | 'gpio'

export const BUS_FILTER_KINDS: readonly BusFilterKind[] = ['spi', 'i2c', 'uart', 'gpio']

export interface ViewportState {
  /** Canvas pan offset in screen pixels. */
  x: number
  y: number
  /** Canvas scale; 1 means board units map 1:1 to pixels. */
  zoom: number
}

export interface WorkspaceState {
  /** Bumped when a field is removed or its meaning changes. */
  version: 1
  panels: {
    library: boolean
    inspector: boolean
    dock: boolean
  }
  dockTab: DockTab
  dockHeight: number
  /** Dock shrunk to its tab strip (the design's collapse chevron). */
  dockCollapsed: boolean
  canvas: {
    tool: CanvasTool
    grid: GridStyle
    snapToGrid: boolean
    /** Net/bus labels drawn on the canvas (View ▸ Bus labels, key `L`). */
    busLabels: boolean
    /** Bus kinds dimmed by the toolbar filter chips. */
    hiddenBuses: BusFilterKind[]
    viewport: ViewportState
  }
  selectedPartId: string | null
}

export const MIN_DOCK_HEIGHT = 120
export const MAX_DOCK_HEIGHT = 640
export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 4

export const DEFAULT_WORKSPACE: WorkspaceState = {
  version: 1,
  panels: { library: true, inspector: true, dock: true },
  dockTab: 'serial',
  dockHeight: 208,
  dockCollapsed: false,
  canvas: {
    tool: 'select',
    grid: 'dot',
    snapToGrid: true,
    busLabels: true,
    hiddenBuses: [],
    viewport: { x: 0, y: 0, zoom: 1 }
  },
  selectedPartId: null
}

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

export type WorkspaceAction =
  | { type: 'togglePanel'; panel: keyof WorkspaceState['panels'] }
  | { type: 'setPanel'; panel: keyof WorkspaceState['panels']; open: boolean }
  | { type: 'setDockTab'; tab: DockTab }
  | { type: 'setDockHeight'; height: number }
  | { type: 'toggleDockCollapsed' }
  | { type: 'setDockCollapsed'; collapsed: boolean }
  | { type: 'setTool'; tool: CanvasTool }
  | { type: 'setGrid'; grid: GridStyle }
  | { type: 'toggleSnapToGrid' }
  | { type: 'toggleBusLabels' }
  | { type: 'toggleBusFilter'; kind: BusFilterKind }
  | { type: 'setViewport'; viewport: ViewportState }
  | { type: 'panBy'; dx: number; dy: number }
  | { type: 'zoomTo'; zoom: number; origin?: { x: number; y: number } }
  | { type: 'selectPart'; partId: string | null }
  | { type: 'replace'; state: WorkspaceState }

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'togglePanel':
      return {
        ...state,
        panels: { ...state.panels, [action.panel]: !state.panels[action.panel] }
      }
    case 'setPanel':
      return { ...state, panels: { ...state.panels, [action.panel]: action.open } }
    case 'setDockTab':
      // Choosing a dock tab while the dock is collapsed opens it, the way the
      // View menu's dock entries behave.
      return { ...state, dockTab: action.tab, panels: { ...state.panels, dock: true } }
    case 'setDockHeight':
      return { ...state, dockHeight: clamp(action.height, MIN_DOCK_HEIGHT, MAX_DOCK_HEIGHT) }
    case 'toggleDockCollapsed':
      return { ...state, dockCollapsed: !state.dockCollapsed }
    case 'setDockCollapsed':
      return { ...state, dockCollapsed: action.collapsed }
    case 'setTool':
      return { ...state, canvas: { ...state.canvas, tool: action.tool } }
    case 'setGrid':
      return { ...state, canvas: { ...state.canvas, grid: action.grid } }
    case 'toggleSnapToGrid':
      return { ...state, canvas: { ...state.canvas, snapToGrid: !state.canvas.snapToGrid } }
    case 'toggleBusLabels':
      return { ...state, canvas: { ...state.canvas, busLabels: !state.canvas.busLabels } }
    case 'toggleBusFilter': {
      const hidden = state.canvas.hiddenBuses.includes(action.kind)
        ? state.canvas.hiddenBuses.filter((kind) => kind !== action.kind)
        : [...state.canvas.hiddenBuses, action.kind]
      return { ...state, canvas: { ...state.canvas, hiddenBuses: hidden } }
    }
    case 'setViewport':
      return {
        ...state,
        canvas: {
          ...state.canvas,
          viewport: {
            ...action.viewport,
            zoom: clamp(action.viewport.zoom, MIN_ZOOM, MAX_ZOOM)
          }
        }
      }
    case 'panBy': {
      const { x, y, zoom } = state.canvas.viewport
      return {
        ...state,
        canvas: { ...state.canvas, viewport: { x: x + action.dx, y: y + action.dy, zoom } }
      }
    }
    case 'zoomTo': {
      const previous = state.canvas.viewport
      const zoom = clamp(action.zoom, MIN_ZOOM, MAX_ZOOM)
      if (!action.origin) {
        return { ...state, canvas: { ...state.canvas, viewport: { ...previous, zoom } } }
      }
      // Keep the board point under the cursor fixed while the scale changes.
      const ratio = zoom / previous.zoom
      return {
        ...state,
        canvas: {
          ...state.canvas,
          viewport: {
            x: action.origin.x - (action.origin.x - previous.x) * ratio,
            y: action.origin.y - (action.origin.y - previous.y) * ratio,
            zoom
          }
        }
      }
    }
    case 'selectPart':
      return { ...state, selectedPartId: action.partId }
    case 'replace':
      return action.state
    default:
      return state
  }
}

/**
 * Coerce whatever came back from disk into a usable state. Persisted layout is
 * a convenience, never a contract: a truncated, hand-edited or older file must
 * degrade to the defaults rather than fail the launch.
 */
export function normaliseWorkspace(input: unknown): WorkspaceState {
  if (typeof input !== 'object' || input === null) return DEFAULT_WORKSPACE
  const raw = input as Partial<WorkspaceState>
  if (raw.version !== DEFAULT_WORKSPACE.version) return DEFAULT_WORKSPACE

  const panels: Partial<WorkspaceState['panels']> = raw.panels ?? {}
  const canvas: Partial<WorkspaceState['canvas']> = raw.canvas ?? {}
  const viewport: Partial<ViewportState> = canvas.viewport ?? {}

  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(value as T) ? (value as T) : fallback
  const bool = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback

  return {
    version: 1,
    panels: {
      library: bool(panels.library, DEFAULT_WORKSPACE.panels.library),
      inspector: bool(panels.inspector, DEFAULT_WORKSPACE.panels.inspector),
      dock: bool(panels.dock, DEFAULT_WORKSPACE.panels.dock)
    },
    // `'diagnostics'` was the single build tab before it split into compiler/console.
    dockTab: pick(
      (raw.dockTab as string) === 'diagnostics' ? 'compiler' : raw.dockTab,
      ['serial', 'compiler', 'console', 'actions', 'agent'],
      DEFAULT_WORKSPACE.dockTab
    ),
    dockHeight: clamp(
      num(raw.dockHeight, DEFAULT_WORKSPACE.dockHeight),
      MIN_DOCK_HEIGHT,
      MAX_DOCK_HEIGHT
    ),
    dockCollapsed: bool(raw.dockCollapsed, DEFAULT_WORKSPACE.dockCollapsed),
    canvas: {
      tool: pick(canvas.tool, ['select', 'pan', 'net', 'probe'], DEFAULT_WORKSPACE.canvas.tool),
      grid: pick(canvas.grid, ['dot', 'line', 'none'], DEFAULT_WORKSPACE.canvas.grid),
      snapToGrid: bool(canvas.snapToGrid, DEFAULT_WORKSPACE.canvas.snapToGrid),
      busLabels: bool(canvas.busLabels, DEFAULT_WORKSPACE.canvas.busLabels),
      hiddenBuses: Array.isArray(canvas.hiddenBuses)
        ? canvas.hiddenBuses.filter((kind): kind is BusFilterKind =>
            BUS_FILTER_KINDS.includes(kind as BusFilterKind)
          )
        : [],
      viewport: {
        x: num(viewport.x, 0),
        y: num(viewport.y, 0),
        zoom: clamp(num(viewport.zoom, 1), MIN_ZOOM, MAX_ZOOM)
      }
    },
    selectedPartId: typeof raw.selectedPartId === 'string' ? raw.selectedPartId : null
  }
}

/**
 * Fit a board of the given size into a viewport, leaving a margin. Shared by
 * the Fit button, the `⇧⌘F` accelerator and the initial view.
 */
export function fitViewport(
  board: { width: number; height: number },
  view: { width: number; height: number },
  margin = 32
): ViewportState {
  const usableWidth = Math.max(1, view.width - margin * 2)
  const usableHeight = Math.max(1, view.height - margin * 2)
  const zoom = clamp(
    Math.min(usableWidth / board.width, usableHeight / board.height),
    MIN_ZOOM,
    MAX_ZOOM
  )
  return {
    x: (view.width - board.width * zoom) / 2,
    y: (view.height - board.height * zoom) / 2,
    zoom
  }
}
