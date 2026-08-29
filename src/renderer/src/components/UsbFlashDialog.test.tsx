import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { INITIAL_USB_FLASH_STATUS } from '@shared/usb-flash'
import type { SerialPortInfo } from '@shared/usb-flash'
import { UsbFlashDialog } from './UsbFlashDialog'

const PORTS: SerialPortInfo[] = [
  { port: '/dev/ttyUSB0', description: 'CP2102', hwid: 'x' },
  { port: '/dev/ttyUSB1', description: '', hwid: 'y' }
]

function props(over: Partial<Parameters<typeof UsbFlashDialog>[0]> = {}) {
  return {
    open: true,
    status: INITIAL_USB_FLASH_STATUS,
    log: [],
    ports: PORTS,
    projectName: 'meshcore',
    env: 'ThinkNode_M9',
    onRefreshPorts: vi.fn(),
    onFlash: vi.fn(),
    onCancel: vi.fn(),
    onClose: vi.fn(),
    ...over
  }
}

describe('UsbFlashDialog', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<UsbFlashDialog {...props({ open: false })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('scans for ports once on open, not on every render', () => {
    const onRefreshPorts = vi.fn()
    const { rerender } = render(<UsbFlashDialog {...props({ onRefreshPorts })} />)
    rerender(<UsbFlashDialog {...props({ onRefreshPorts, ports: [...PORTS] })} />)
    expect(onRefreshPorts).toHaveBeenCalledTimes(1)
  })

  it('flashes the selected port in the chosen mode', async () => {
    const onFlash = vi.fn()
    render(<UsbFlashDialog {...props({ onFlash })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Flash' }))
    expect(onFlash).toHaveBeenCalledWith('/dev/ttyUSB0', 'flash')
  })

  it('warns and switches the primary button for erase + flash', async () => {
    const onFlash = vi.fn()
    render(<UsbFlashDialog {...props({ onFlash })} />)
    await userEvent.click(screen.getByRole('radio', { name: /Erase \+ flash/ }))
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot be undone/i)
    await userEvent.click(screen.getByRole('button', { name: 'Erase & flash' }))
    expect(onFlash).toHaveBeenCalledWith('/dev/ttyUSB0', 'erase-flash')
  })

  it('blocks flashing when no PlatformIO project is attached', () => {
    render(<UsbFlashDialog {...props({ projectName: null, env: null })} />)
    expect(screen.getByRole('button', { name: 'Flash' })).toBeDisabled()
    expect(screen.getByText(/Attach a PlatformIO project/)).toBeInTheDocument()
  })

  it('shows Cancel instead of Close while a flash is running', () => {
    const onCancel = vi.fn()
    render(<UsbFlashDialog {...props({ status: { state: 'flashing', percent: 55 }, onCancel })} />)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '55')
  })
})
