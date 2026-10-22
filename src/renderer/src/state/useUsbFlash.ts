import { useCallback, useEffect, useRef, useState } from 'react'
import type { BuildOutputLine } from '@shared/build'
import { INITIAL_USB_FLASH_STATUS } from '@shared/usb-flash'
import type { SerialPortInfo, UsbFlashStatus } from '@shared/usb-flash'
import type { UsbFlashRequest } from '@shared/ipc'

const MAX_LOG_LINES = 5_000

export interface UsbFlashHandle {
  status: UsbFlashStatus
  log: BuildOutputLine[]
  /** Ports from the last `refreshPorts()`; empty until one runs. */
  ports: SerialPortInfo[]
  refreshPorts(): Promise<SerialPortInfo[]>
  start(request: UsbFlashRequest): void
  cancel(): void
  reset(): void
}

/** Subscribes to the USB-flash pipeline — mirrors `useBuild`, minus diagnostics. */
export function useUsbFlash(): UsbFlashHandle {
  const [status, setStatus] = useState<UsbFlashStatus>(INITIAL_USB_FLASH_STATUS)
  const [log, setLog] = useState<BuildOutputLine[]>([])
  const [ports, setPorts] = useState<SerialPortInfo[]>([])
  const logRef = useRef<BuildOutputLine[]>([])

  useEffect(() => {
    return window.pinbench.usbFlash.onState((next: UsbFlashStatus) => {
      setStatus(next)
      if (next.state === 'building') {
        logRef.current = []
        setLog([])
      }
    })
  }, [])

  useEffect(() => {
    return window.pinbench.usbFlash.onOutput((line: BuildOutputLine) => {
      const lines = logRef.current
      if (line.replace && lines.length > 0) lines[lines.length - 1] = line
      else lines.push(line)
      if (lines.length > MAX_LOG_LINES) logRef.current = lines.slice(-MAX_LOG_LINES)
      setLog([...logRef.current])
    })
  }, [])

  const refreshPorts = useCallback(async () => {
    const found = await window.pinbench.usbFlash.listPorts()
    setPorts(found)
    return found
  }, [])

  const start = useCallback(
    (request: UsbFlashRequest) => window.pinbench.usbFlash.start(request),
    []
  )
  const cancel = useCallback(() => window.pinbench.usbFlash.cancel(), [])
  const reset = useCallback(() => {
    logRef.current = []
    setLog([])
    setStatus(INITIAL_USB_FLASH_STATUS)
  }, [])

  return { status, log, ports, refreshPorts, start, cancel, reset }
}
