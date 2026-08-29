import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { PartDefinition } from '@shared/board'
import type { DeviceSnapshotMessage } from '@shared/devices/messages'
import { OutPanel } from './OutPanel'
import type { PartDeviceView } from '../state/useDevices'

const LED_PART: PartDefinition = {
  id: 'd1',
  designator: 'D1',
  name: 'Status LED',
  category: 'interface',
  deviceModel: 'pinbench.led',
  summary: 'demo',
  buses: [],
  pins: [{ signal: 'ANODE', pin: 'GPIO45' }],
  config: [],
  layout: { x: 0, y: 0, width: 1, height: 1 }
}

function snapshot(over: Partial<DeviceSnapshotMessage> = {}): DeviceSnapshotMessage {
  return {
    partId: 'd1',
    deviceModel: 'pinbench.led',
    designator: 'D1',
    name: 'Status LED',
    state: { lit: false },
    meters: [
      { id: 'duty', label: 'Duty cycle', unit: '%', value: 0 },
      { id: 'edges', label: 'Edges', value: 0 }
    ],
    quarantined: false,
    ...over
  }
}

describe('OutPanel', () => {
  it('waits for activity when no snapshot has arrived', () => {
    render(<OutPanel part={LED_PART} view={undefined} />)
    expect(screen.getByText(/waiting for bus activity/i)).toBeInTheDocument()
  })

  it('shows the LED dark, then lit, from the snapshot', () => {
    const { rerender } = render(
      <OutPanel part={LED_PART} view={{ snapshot: snapshot(), events: [] }} />
    )
    expect(screen.getByLabelText('LED dark')).toBeInTheDocument()

    rerender(
      <OutPanel
        part={LED_PART}
        view={{ snapshot: snapshot({ state: { lit: true } }), events: [] }}
      />
    )
    expect(screen.getByLabelText('LED lit')).toBeInTheDocument()
  })

  it('renders the declared meters', () => {
    const view: PartDeviceView = {
      snapshot: snapshot({ meters: [{ id: 'edges', label: 'Edges', value: 12 }] }),
      events: []
    }
    render(<OutPanel part={LED_PART} view={view} />)
    expect(screen.getByText('Edges')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
  })

  it('lists recent events newest-first', () => {
    const view: PartDeviceView = {
      snapshot: snapshot(),
      events: [
        { t: 1_000_000, kind: 'edge', summary: 'LED on' },
        { t: 2_000_000, kind: 'edge', summary: 'LED off' }
      ]
    }
    render(<OutPanel part={LED_PART} view={view} />)
    const items = screen.getAllByRole('listitem').map((li) => li.textContent)
    expect(items[0]).toContain('LED off')
    expect(items[1]).toContain('LED on')
  })

  it('drives the line high, then low, from the Toggle control', async () => {
    const onSetLevel = vi.fn()
    const { rerender } = render(
      <OutPanel
        part={LED_PART}
        view={{ snapshot: snapshot({ state: { lit: false, pin: 0 } }), events: [] }}
        onSetLevel={onSetLevel}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Drive high' }))
    expect(onSetLevel).toHaveBeenLastCalledWith('ANODE', 1)

    rerender(
      <OutPanel
        part={LED_PART}
        view={{ snapshot: snapshot({ state: { lit: true, pin: 1 } }), events: [] }}
        onSetLevel={onSetLevel}
      />
    )
    await userEvent.click(screen.getByRole('button', { name: 'Drive low' }))
    expect(onSetLevel).toHaveBeenLastCalledWith('ANODE', 0)
  })

  it('warns when the model is quarantined', () => {
    render(
      <OutPanel part={LED_PART} view={{ snapshot: snapshot({ quarantined: true }), events: [] }} />
    )
    expect(screen.getByRole('status')).toHaveTextContent(/quarantined/i)
  })

  it('renders the e-paper canvas for the SSD1680 model', () => {
    const EINK_PART: PartDefinition = {
      id: 'u3',
      designator: 'U3',
      name: '2.13" e-paper',
      category: 'display',
      deviceModel: 'solomon.ssd1680',
      summary: 'demo',
      buses: ['spi-disp'],
      pins: [{ signal: 'CS', pin: 'GPIO4' }],
      config: [
        {
          id: 'scale',
          label: 'Panel zoom',
          kind: 'segmented',
          options: ['1×', '2×', '3×'],
          value: '2×'
        }
      ],
      layout: { x: 0, y: 0, width: 1, height: 1 }
    }
    render(
      <OutPanel
        part={EINK_PART}
        view={{
          snapshot: snapshot({ deviceModel: 'solomon.ssd1680', state: {}, meters: [] }),
          events: []
        }}
      />
    )
    expect(screen.getByLabelText('E-paper panel output')).toBeInTheDocument()
  })
})
