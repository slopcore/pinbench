import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { BoardDefinition, PartDefinition } from '@shared/board'
import { Inspector } from './Inspector'

const PART: PartDefinition = {
  id: 'u2',
  designator: 'U2',
  name: 'Widget radio',
  category: 'radio',
  summary: 'demo part',
  buses: ['spi0'],
  pins: [{ signal: 'NSS', pin: 'GPIO39' }],
  config: [],
  layout: { x: 40, y: 90, width: 170, height: 120 },
  firmwareHook: {
    symbol: 'Widget::begin()',
    file: 'src/Widget.cpp',
    line: 12,
    note: 'brings it up'
  }
}

const BOARD = {
  schema: 1,
  id: 'b',
  name: 'Board',
  mcu: 'ESP32-S3',
  vendor: 'Acme',
  pins: [],
  buses: [{ id: 'spi0', kind: 'spi', label: 'SPI0', signals: {} }],
  parts: [PART],
  nets: [
    { id: 'n1', label: 'SPI0 · NSS39', bus: 'spi0', nodes: ['u2:NSS'] },
    { id: 'n2', label: 'IRQ', nodes: ['u2:NSS'] }
  ],
  emulator: {},
  canvas: { width: 800, height: 600 }
} as unknown as BoardDefinition

describe('Inspector', () => {
  it('renders Identity, Nets and the firmware-hook card', () => {
    render(<Inspector part={PART} board={BOARD} values={{}} onConfigChange={() => {}} />)
    expect(screen.getByText('Identity')).toBeInTheDocument()
    expect(screen.getByText('Reference')).toBeInTheDocument()
    // U2 shows in the heading and the Identity "Reference" row.
    expect(screen.getAllByText('U2').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('40, 90')).toBeInTheDocument()
    expect(screen.getByText('Nets (2)')).toBeInTheDocument()
    expect(screen.getByText('SPI0 · NSS39')).toBeInTheDocument()
    expect(screen.getByText('Widget::begin()')).toBeInTheDocument()
    expect(screen.getByText('brings it up')).toBeInTheDocument()
  })

  it('calls onRevealSource with the hook file and line', async () => {
    const onRevealSource = vi.fn()
    const user = userEvent.setup()
    render(
      <Inspector
        part={PART}
        board={BOARD}
        values={{}}
        onConfigChange={() => {}}
        onRevealSource={onRevealSource}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Reveal in source' }))
    expect(onRevealSource).toHaveBeenCalledWith('src/Widget.cpp', 12)
  })

  it('hides the reveal button when the hook names no file', () => {
    const noFile: PartDefinition = { ...PART, firmwareHook: { symbol: 'app_main()' } }
    render(
      <Inspector
        part={noFile}
        board={BOARD}
        values={{}}
        onConfigChange={() => {}}
        onRevealSource={() => {}}
      />
    )
    expect(screen.getByText('app_main()')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reveal in source' })).not.toBeInTheDocument()
  })

  it('omits the Nets section for a part with no connected nets', () => {
    const lonely = { ...BOARD, nets: [] } as unknown as BoardDefinition
    render(<Inspector part={PART} board={lonely} values={{}} onConfigChange={() => {}} />)
    expect(screen.queryByText(/^Nets \(/)).not.toBeInTheDocument()
    // Identity still renders.
    expect(
      within(screen.getByRole('complementary', { name: 'Inspector' })).getByText('Identity')
    ).toBeInTheDocument()
  })
})
