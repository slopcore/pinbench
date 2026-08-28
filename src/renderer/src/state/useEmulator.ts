import { useCallback, useEffect, useRef, useState } from 'react'
import type { EmulatorState, EmulatorStatus } from '@shared/emulator'
import type { SerialLine } from '@shared/serial'

const MAX_SERIAL_LINES = 10_000

export interface EmulatorHandle {
  state: EmulatorState
  error: string | undefined
  serial: SerialLine[]
  openAndStart(): void
  start(firmwarePath: string): void
  stop(): void
  reset(): void
  writeSerial(text: string): void
  firmwarePath: string | null
}

export function useEmulator(): EmulatorHandle {
  const [state, setState] = useState<EmulatorState>('idle')
  const [error, setError] = useState<string | undefined>()
  const [serial, setSerial] = useState<SerialLine[]>([])
  const [firmwarePath, setFirmwarePath] = useState<string | null>(null)
  const serialRef = useRef<SerialLine[]>([])

  useEffect(() => {
    return window.pinbench.emulator.onStatus((status: EmulatorStatus) => {
      setState(status.state)
      setError(status.error)
      if (status.state === 'starting') {
        serialRef.current = []
        setSerial([])
      }
    })
  }, [])

  useEffect(() => {
    return window.pinbench.serial.onData((lines: SerialLine[]) => {
      serialRef.current = [...serialRef.current, ...lines]
      if (serialRef.current.length > MAX_SERIAL_LINES) {
        serialRef.current = serialRef.current.slice(-MAX_SERIAL_LINES)
      }
      setSerial(serialRef.current)
    })
  }, [])

  const start = useCallback((path: string) => {
    setFirmwarePath(path)
    window.pinbench.emulator.start(path)
  }, [])

  const openAndStart = useCallback(async () => {
    const path = await window.pinbench.emulator.openFirmware()
    if (path) start(path)
  }, [start])

  const stop = useCallback(() => {
    window.pinbench.emulator.stop()
  }, [])

  const reset = useCallback(() => {
    window.pinbench.emulator.reset()
  }, [])

  const writeSerial = useCallback((text: string) => {
    window.pinbench.serial.write(text)
  }, [])

  return { state, error, serial, openAndStart, start, stop, reset, writeSerial, firmwarePath }
}
