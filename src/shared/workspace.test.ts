import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WORKSPACE,
  MAX_DOCK_HEIGHT,
  MAX_ZOOM,
  MIN_DOCK_HEIGHT,
  MIN_ZOOM,
  fitViewport,
  normaliseWorkspace,
  workspaceReducer
} from './workspace'
import type { WorkspaceState } from './workspace'

const reduce = (state: WorkspaceState, ...actions: Parameters<typeof workspaceReducer>[1][]) =>
  actions.reduce(workspaceReducer, state)

describe('workspaceReducer', () => {
  it('toggles a panel without disturbing its neighbours', () => {
    const next = workspaceReducer(DEFAULT_WORKSPACE, { type: 'togglePanel', panel: 'library' })
    expect(next.panels.library).toBe(false)
    expect(next.panels.inspector).toBe(true)
    expect(next.panels.dock).toBe(true)
  })

  it('opens the dock when a dock tab is chosen while it is hidden', () => {
    const hidden = workspaceReducer(DEFAULT_WORKSPACE, { type: 'togglePanel', panel: 'dock' })
    const next = workspaceReducer(hidden, { type: 'setDockTab', tab: 'diagnostics' })
    expect(next.panels.dock).toBe(true)
    expect(next.dockTab).toBe('diagnostics')
  })

  it('clamps the dock height to its bounds', () => {
    expect(
      workspaceReducer(DEFAULT_WORKSPACE, { type: 'setDockHeight', height: 5 }).dockHeight
    ).toBe(MIN_DOCK_HEIGHT)
    expect(
      workspaceReducer(DEFAULT_WORKSPACE, { type: 'setDockHeight', height: 9999 }).dockHeight
    ).toBe(MAX_DOCK_HEIGHT)
  })

  it('clamps zoom in both directions', () => {
    expect(
      workspaceReducer(DEFAULT_WORKSPACE, { type: 'zoomTo', zoom: 100 }).canvas.viewport.zoom
    ).toBe(MAX_ZOOM)
    expect(
      workspaceReducer(DEFAULT_WORKSPACE, { type: 'zoomTo', zoom: 0.001 }).canvas.viewport.zoom
    ).toBe(MIN_ZOOM)
  })

  it('keeps the board point under the cursor fixed while zooming', () => {
    const origin = { x: 200, y: 120 }
    const before = DEFAULT_WORKSPACE.canvas.viewport
    const after = workspaceReducer(DEFAULT_WORKSPACE, { type: 'zoomTo', zoom: 2, origin }).canvas
      .viewport

    // The board coordinate under the cursor is (origin - offset) / zoom.
    const boardBefore = (origin.x - before.x) / before.zoom
    const boardAfter = (origin.x - after.x) / after.zoom
    expect(boardAfter).toBeCloseTo(boardBefore, 6)
  })

  it('accumulates pans', () => {
    const next = reduce(
      DEFAULT_WORKSPACE,
      { type: 'panBy', dx: 10, dy: -5 },
      { type: 'panBy', dx: 4, dy: 5 }
    )
    expect(next.canvas.viewport).toMatchObject({ x: 14, y: 0 })
  })

  it('toggles the dock collapsed flag', () => {
    expect(reduce(DEFAULT_WORKSPACE, { type: 'toggleDockCollapsed' }).dockCollapsed).toBe(true)
    expect(
      reduce(DEFAULT_WORKSPACE, { type: 'toggleDockCollapsed' }, { type: 'toggleDockCollapsed' })
        .dockCollapsed
    ).toBe(false)
  })

  it('toggles bus labels', () => {
    expect(reduce(DEFAULT_WORKSPACE, { type: 'toggleBusLabels' }).canvas.busLabels).toBe(false)
  })

  it('adds and removes a bus filter without duplicating it', () => {
    const hidden = reduce(
      DEFAULT_WORKSPACE,
      { type: 'toggleBusFilter', kind: 'spi' },
      { type: 'toggleBusFilter', kind: 'i2c' },
      { type: 'toggleBusFilter', kind: 'spi' }
    ).canvas.hiddenBuses
    expect(hidden).toEqual(['i2c'])
  })
})

describe('normaliseWorkspace', () => {
  it('falls back to defaults for junk', () => {
    expect(normaliseWorkspace(null)).toEqual(DEFAULT_WORKSPACE)
    expect(normaliseWorkspace('not a workspace')).toEqual(DEFAULT_WORKSPACE)
    expect(normaliseWorkspace({})).toEqual(DEFAULT_WORKSPACE)
  })

  it('drops a state written by an older version', () => {
    expect(normaliseWorkspace({ ...DEFAULT_WORKSPACE, version: 0 })).toEqual(DEFAULT_WORKSPACE)
  })

  it('keeps valid fields and repairs invalid ones', () => {
    const restored = normaliseWorkspace({
      version: 1,
      panels: { library: false, inspector: 'yes', dock: true },
      workspaceTab: 'source',
      dockTab: 'nonsense',
      dockHeight: 12_000,
      canvas: {
        tool: 'pan',
        grid: 'line',
        snapToGrid: false,
        busLabels: false,
        hiddenBuses: ['spi', 'bogus'],
        viewport: { x: 12, y: -4, zoom: 99 }
      },
      selectedPartId: 'u2'
    })

    expect(restored.canvas.busLabels).toBe(false)
    expect(restored.canvas.hiddenBuses).toEqual(['spi'])
    expect(restored.panels.library).toBe(false)
    expect(restored.panels.inspector).toBe(DEFAULT_WORKSPACE.panels.inspector)
    expect(restored.workspaceTab).toBe('source')
    expect(restored.dockTab).toBe(DEFAULT_WORKSPACE.dockTab)
    expect(restored.dockHeight).toBe(MAX_DOCK_HEIGHT)
    expect(restored.canvas.tool).toBe('pan')
    expect(restored.canvas.viewport).toEqual({ x: 12, y: -4, zoom: MAX_ZOOM })
    expect(restored.selectedPartId).toBe('u2')
  })

  it('fills the new canvas/dock fields on a v1 state that predates them', () => {
    const { canvas, selectedPartId, ...rest } = DEFAULT_WORKSPACE
    const canvasRest: Record<string, unknown> = { ...canvas }
    delete canvasRest['busLabels']
    delete canvasRest['hiddenBuses']
    const legacy = { ...rest, canvas: canvasRest } as unknown
    const restored = normaliseWorkspace(legacy)
    expect(restored.dockCollapsed).toBe(false)
    expect(restored.canvas.busLabels).toBe(true)
    expect(restored.canvas.hiddenBuses).toEqual([])
    expect(restored.selectedPartId).toBe(selectedPartId)
  })

  it('round-trips a state it produced', () => {
    const once = normaliseWorkspace(DEFAULT_WORKSPACE)
    expect(normaliseWorkspace(JSON.parse(JSON.stringify(once)))).toEqual(once)
  })
})

describe('fitViewport', () => {
  it('centres the board and leaves the margin', () => {
    const viewport = fitViewport({ width: 800, height: 400 }, { width: 1000, height: 600 }, 50)
    expect(viewport.zoom).toBeCloseTo(900 / 800, 6)
    expect(viewport.x).toBeCloseTo((1000 - 800 * viewport.zoom) / 2, 6)
    expect(viewport.y).toBeCloseTo((600 - 400 * viewport.zoom) / 2, 6)
  })

  it('never returns a zoom outside the allowed range', () => {
    expect(fitViewport({ width: 10, height: 10 }, { width: 4000, height: 4000 }).zoom).toBe(
      MAX_ZOOM
    )
    expect(fitViewport({ width: 40_000, height: 40_000 }, { width: 100, height: 100 }).zoom).toBe(
      MIN_ZOOM
    )
  })

  it('survives being asked to fit into nothing', () => {
    const viewport = fitViewport({ width: 800, height: 400 }, { width: 0, height: 0 })
    expect(Number.isFinite(viewport.x)).toBe(true)
    expect(Number.isFinite(viewport.y)).toBe(true)
    expect(viewport.zoom).toBeGreaterThanOrEqual(MIN_ZOOM)
  })
})
