import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  DeviceEventMessage,
  DeviceFramebufferMessage,
  DeviceSnapshotMessage
} from '@shared/devices/messages'
import type { Diagnostic } from '@shared/diagnostics'

const MAX_EVENTS_PER_PART = 200
const MAX_DIAGNOSTICS = 100

export interface PartDeviceView {
  snapshot: DeviceSnapshotMessage | undefined
  events: DeviceEventMessage['event'][]
  /** Latest display framebuffer for this part (M6, ST7789 only). */
  framebuffer?: DeviceFramebufferMessage
}

export interface DevicesHandle {
  /** Model state and recent events, keyed by part id. */
  byPart: Map<string, PartDeviceView>
  /** Device-host diagnostics, for merging into the Diagnostics dock. */
  diagnostics: Diagnostic[]
  /** Drive a line into a device to a level — a stand-in until M6 feeds real GPIO edges. */
  setSignal(partId: string, signal: string, level: 0 | 1): void
  /** Send an IN-panel command to a model's `onCommand` (LR1110 `inject`, `setParam`). */
  sendCommand(partId: string, command: string, args?: Record<string, unknown>): void
}

interface DevicesState {
  snapshots: Map<string, DeviceSnapshotMessage>
  events: Map<string, DeviceEventMessage['event'][]>
  framebuffers: Map<string, DeviceFramebufferMessage>
  diagnostics: Diagnostic[]
}

/**
 * Subscribes to the main-process device host. The host instantiates models when
 * it loads the board (`board:load`, from `useBoard`), so this hook only fans
 * snapshots and events out to the OUT panels and device diagnostics into the
 * Diagnostics dock, through the same `onDiagnostic` bridge the build uses.
 */
export function useDevices(): DevicesHandle {
  const [state, setState] = useState<DevicesState>(() => ({
    snapshots: new Map(),
    events: new Map(),
    framebuffers: new Map(),
    diagnostics: []
  }))

  useEffect(() => {
    return window.pinbench.devices.onSnapshot((message) => {
      setState((previous) => {
        const snapshots = new Map(previous.snapshots)
        snapshots.set(message.partId, message)
        return { ...previous, snapshots }
      })
    })
  }, [])

  useEffect(() => {
    return window.pinbench.devices.onEvent((message) => {
      setState((previous) => {
        const events = new Map(previous.events)
        const grown = [...(events.get(message.partId) ?? []), message.event]
        events.set(
          message.partId,
          grown.length > MAX_EVENTS_PER_PART ? grown.slice(-MAX_EVENTS_PER_PART) : grown
        )
        return { ...previous, events }
      })
    })
  }, [])

  useEffect(() => {
    return window.pinbench.devices.onFramebuffer((message) => {
      setState((previous) => {
        const framebuffers = new Map(previous.framebuffers)
        framebuffers.set(message.partId, message)
        return { ...previous, framebuffers }
      })
    })
  }, [])

  useEffect(() => {
    return window.pinbench.devices.onDiagnostic((row) => {
      setState((previous) => {
        const without = previous.diagnostics.filter((d) => d.id !== row.id)
        const grown = [...without, row]
        return {
          ...previous,
          diagnostics: grown.length > MAX_DIAGNOSTICS ? grown.slice(-MAX_DIAGNOSTICS) : grown
        }
      })
    })
  }, [])

  const setSignal = useCallback((partId: string, signal: string, level: 0 | 1) => {
    window.pinbench.devices.command({ partId, command: 'signal', args: { signal, level } })
  }, [])

  /** Send an IN-panel command to a model's `onCommand` (LR1110 `inject` etc.). */
  const sendCommand = useCallback(
    (partId: string, command: string, args?: Record<string, unknown>) => {
      window.pinbench.devices.command({ partId, command, ...(args ? { args } : {}) })
    },
    []
  )

  const byPart = useMemo(() => {
    const map = new Map<string, PartDeviceView>()
    const partIds = new Set([
      ...state.snapshots.keys(),
      ...state.events.keys(),
      ...state.framebuffers.keys()
    ])
    for (const partId of partIds) {
      const framebuffer = state.framebuffers.get(partId)
      map.set(partId, {
        snapshot: state.snapshots.get(partId),
        events: state.events.get(partId) ?? [],
        ...(framebuffer ? { framebuffer } : {})
      })
    }
    return map
  }, [state.snapshots, state.events, state.framebuffers])

  return { byPart, diagnostics: state.diagnostics, setSignal, sendCommand }
}
