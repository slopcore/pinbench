import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORKSPACE } from '@shared/workspace'
import type { ViewportState, WorkspaceState } from '@shared/workspace'
import { Canvas } from './Canvas'
import { M9_BOARD } from '../../../../test/board'
import '../../../../test/setup'

function renderCanvas(overrides: Partial<WorkspaceState['canvas']> = {}): {
  onViewport: ReturnType<typeof vi.fn>
  onZoomAt: ReturnType<typeof vi.fn>
  onSelectPart: ReturnType<typeof vi.fn>
  onMovePart: ReturnType<typeof vi.fn>
  onAddNet: ReturnType<typeof vi.fn>
  surface: HTMLElement
} {
  const onViewport = vi.fn()
  const onZoomAt = vi.fn()
  const onSelectPart = vi.fn()
  const onMovePart = vi.fn()
  const onAddNet = vi.fn()
  const workspace: WorkspaceState = {
    ...DEFAULT_WORKSPACE,
    canvas: { ...DEFAULT_WORKSPACE.canvas, ...overrides }
  }
  render(
    <Canvas
      board={M9_BOARD}
      workspace={workspace}
      onViewport={onViewport}
      onZoomAt={onZoomAt}
      onSelectPart={onSelectPart}
      onMovePart={onMovePart}
      onAddNet={onAddNet}
      onMeasure={() => undefined}
      ready
    />
  )
  return {
    onViewport,
    onZoomAt,
    onSelectPart,
    onMovePart,
    onAddNet,
    surface: screen.getByRole('application', { name: /diagram/i })
  }
}

describe('Canvas', () => {
  it('pans on a plain wheel', () => {
    const { onViewport, surface } = renderCanvas({ viewport: { x: 100, y: 100, zoom: 1 } })
    fireEvent.wheel(surface, { deltaX: 20, deltaY: 40 })
    expect(onViewport).toHaveBeenCalledWith<[ViewportState]>({ x: 80, y: 60, zoom: 1 })
  })

  it('zooms at the cursor on a pinch or ctrl-wheel', () => {
    const { onZoomAt, surface } = renderCanvas()
    fireEvent.wheel(surface, { deltaY: -100, ctrlKey: true, clientX: 120, clientY: 80 })
    expect(onZoomAt).toHaveBeenCalledTimes(1)
    const [zoom, origin] = onZoomAt.mock.calls[0] as [number, { x: number; y: number }]
    expect(zoom).toBeGreaterThan(1)
    expect(origin).toEqual({ x: 120, y: 80 })
  })

  it('drags the view with the Pan tool', () => {
    const { onViewport, surface } = renderCanvas({
      tool: 'pan',
      viewport: { x: 0, y: 0, zoom: 1 }
    })
    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 100, clientY: 100, button: 0 })
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 130, clientY: 90 })
    expect(onViewport).toHaveBeenCalledWith<[ViewportState]>({ x: 30, y: -10, zoom: 1 })
    fireEvent.pointerUp(surface, { pointerId: 1 })
  })

  it('does not drag the view with the Select tool', () => {
    const { onViewport, surface } = renderCanvas({ tool: 'select' })
    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 100, clientY: 100, button: 0 })
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 130, clientY: 90 })
    expect(onViewport).not.toHaveBeenCalled()
  })

  it('pans with the middle button whatever the tool', () => {
    const { onViewport, surface } = renderCanvas({ tool: 'select' })
    fireEvent.pointerDown(surface, { pointerId: 2, clientX: 10, clientY: 10, button: 1 })
    fireEvent.pointerMove(surface, { pointerId: 2, clientX: 15, clientY: 12 })
    expect(onViewport).toHaveBeenCalled()
  })

  it('selects a part and clears the selection on empty space', async () => {
    const { onSelectPart, surface } = renderCanvas()
    fireEvent.click(screen.getByText('LR1110 mesh radio'))
    await waitFor(() => expect(onSelectPart).toHaveBeenCalledWith('u2'))
    fireEvent.click(surface)
    expect(onSelectPart).toHaveBeenLastCalledWith(null)
  })

  it('draws the grid the workspace asks for', () => {
    const { surface } = renderCanvas({ grid: 'line' })
    expect(surface.querySelector('rect[fill="url(#grid-line)"]')).not.toBeNull()
    expect(surface.querySelector('rect[fill="url(#grid-dot)"]')).toBeNull()
  })

  it('draws no grid at all when the grid is off', () => {
    const { surface } = renderCanvas({ grid: 'none' })
    expect(surface.querySelector('rect[fill^="url(#grid"]')).toBeNull()
  })

  it('gives each node card a CFG/IN/OUT strip that switches its body', async () => {
    const { onSelectPart } = renderCanvas()
    const radioCard = screen.getByText('LR1110 mesh radio').closest('.canvas__card') as HTMLElement
    // CFG is the default body — a pin row is visible.
    expect(radioCard.querySelector('.canvas__card-pins')).not.toBeNull()
    fireEvent.click(within(radioCard).getByRole('tab', { name: 'IN' }))
    await waitFor(() => expect(onSelectPart).toHaveBeenCalledWith('u2'))
    expect(radioCard.querySelector('.canvas__card-pins')).toBeNull()
    expect(within(radioCard).getByText(/Stimuli available/)).toBeInTheDocument()
  })

  it('labels nets on the canvas and hides the labels when bus labels are off', () => {
    const { surface } = renderCanvas({ busLabels: true })
    expect(surface.querySelector('.canvas__net-label')).not.toBeNull()
    cleanup()
    const off = renderCanvas({ busLabels: false })
    expect(off.surface.querySelector('.canvas__net-label')).toBeNull()
  })

  it('dims the nets of a filtered-out bus', () => {
    const { surface } = renderCanvas({ hiddenBuses: ['spi'] })
    expect(surface.querySelector('.canvas__net-group[data-dimmed]')).not.toBeNull()
  })

  it('commits a part drag with the Select tool, snapped to the grid', () => {
    const { onMovePart } = renderCanvas({ tool: 'select', snapToGrid: true })
    const card = screen.getByText('LR1110 mesh radio').closest('.canvas__card') as HTMLElement
    fireEvent.pointerDown(card, { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 47, clientY: 33 })
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 47, clientY: 33 })
    // u2 sits at x:60 y:200 in the M9 definition; +47,+33 snapped to /10.
    expect(onMovePart).toHaveBeenCalledWith('u2', 110, 230)
  })

  it('does not move a part on a plain click (no drag)', () => {
    const { onMovePart, onSelectPart } = renderCanvas({ tool: 'select' })
    const card = screen.getByText('LR1110 mesh radio').closest('.canvas__card') as HTMLElement
    fireEvent.pointerDown(card, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.click(card)
    expect(onMovePart).not.toHaveBeenCalled()
    expect(onSelectPart).toHaveBeenCalledWith('u2')
  })

  it('wires a net between the two parts clicked with the Draw-net tool', () => {
    const { onAddNet } = renderCanvas({ tool: 'net' })
    fireEvent.click(screen.getByText('LR1110 mesh radio').closest('.canvas__card') as HTMLElement)
    expect(onAddNet).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('2.4" LCD').closest('.canvas__card') as HTMLElement)
    expect(onAddNet).toHaveBeenCalledTimes(1)
    const net = onAddNet.mock.calls[0]![0]
    expect(net.nodes[0]).toMatch(/^u2:/)
    expect(net.nodes[1]).toMatch(/^u3:/)
  })
})
