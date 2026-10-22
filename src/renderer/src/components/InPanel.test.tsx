import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { PartDefinition } from '@shared/board'
import { InPanel } from './InPanel'

const part = (deviceModel: string | undefined): PartDefinition => ({
  id: 'u1',
  designator: 'U1',
  name: 'Test part',
  category: 'sensor',
  ...(deviceModel ? { deviceModel } : {}),
  summary: '',
  buses: [],
  pins: [],
  config: [],
  layout: { x: 0, y: 0, width: 1, height: 1 }
})

describe('InPanel', () => {
  it('renders nothing for a model with no stimulus set', () => {
    const { container } = render(<InPanel part={part('sitronix.st7789')} onCommand={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the generic button panel and sends the mapped command', async () => {
    const onCommand = vi.fn()
    const user = userEvent.setup()
    render(<InPanel part={part('generic.sdcard')} onCommand={onCommand} />)
    await user.click(screen.getByRole('button', { name: 'Remove card' }))
    expect(onCommand).toHaveBeenCalledWith('card', { present: false })
  })

  it('gives the GNSS NMEA scenarios', () => {
    render(<InPanel part={part('zhongke.atgm336h')} onCommand={() => {}} />)
    expect(screen.getByRole('button', { name: /3D fix/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /No fix/ })).toBeInTheDocument()
  })

  it('renders the keyboard matrix, D-pad, shortcuts and a live buffer', async () => {
    const onCommand = vi.fn()
    const user = userEvent.setup()
    render(<InPanel part={part('pinbench.kbd-coprocessor')} onCommand={onCommand} />)
    await user.click(screen.getByRole('button', { name: 'H' }))
    await user.click(screen.getByRole('button', { name: 'I' }))
    expect(onCommand).toHaveBeenCalledWith('key', { key: 'H' })
    expect(screen.getByText('HI')).toBeInTheDocument()
    // D-pad + shortcut keys present.
    expect(screen.getByRole('button', { name: 'OK' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'CHAT' })).toBeInTheDocument()
  })

  it('keeps the LR1110 rich panel', () => {
    render(<InPanel part={part('semtech.lr1110')} onCommand={() => {}} />)
    const panel = screen.getByRole('region', { name: 'Input' })
    expect(within(panel).getByLabelText('RSSI dBm')).toBeInTheDocument()
  })

  it('gives the SX1262 the same frame-injection panel', async () => {
    const onCommand = vi.fn()
    const user = userEvent.setup()
    render(<InPanel part={part('semtech.sx1262')} onCommand={onCommand} />)
    const panel = screen.getByRole('region', { name: 'Input' })
    expect(within(panel).getByLabelText('RSSI dBm')).toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: 'Send channel' }))
    expect(onCommand).toHaveBeenCalledWith(
      'inject',
      expect.objectContaining({ kind: 'channel', text: expect.any(String) })
    )
  })

  it('sends a direct message with the lorem-prefilled text', async () => {
    const onCommand = vi.fn()
    const user = userEvent.setup()
    render(<InPanel part={part('semtech.sx1262')} onCommand={onCommand} />)
    const panel = screen.getByRole('region', { name: 'Input' })
    expect((within(panel).getByLabelText('Message text') as HTMLInputElement).value).toMatch(
      /^Lorem ipsum/
    )
    await user.click(within(panel).getByRole('button', { name: 'Send direct' }))
    expect(onCommand).toHaveBeenCalledWith(
      'inject',
      expect.objectContaining({ kind: 'direct', text: expect.stringMatching(/^Lorem ipsum/) })
    )
  })

  it('pairs the synthetic sender before a direct message can land', async () => {
    const onCommand = vi.fn()
    const user = userEvent.setup()
    render(<InPanel part={part('semtech.sx1262')} onCommand={onCommand} />)
    const panel = screen.getByRole('region', { name: 'Input' })
    await user.click(within(panel).getByRole('button', { name: 'Pair sender' }))
    expect(onCommand).toHaveBeenCalledWith('inject', expect.objectContaining({ kind: 'pair' }))
  })
})
