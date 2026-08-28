import { useCallback, useEffect, useState } from 'react'
import type { DeviceEventMessage, DeviceSnapshotMessage } from '@shared/devices/messages'
import type { Diagnostic } from '@shared/diagnostics'

const MAX_EVENTS_PER_PART = 200
const MAX_DIAGNOSTICS = 100

export interface PartDeviceView {
  snapshot: DeviceSnapshotMessage | undefined
  events: DeviceEventMessage['event'][]
}

export interface DevicesHandle {
  /** Model state and recent events, keyed by part id. */
  byPart: Map<string, PartDeviceView>
  /** Device-host diagnostics, for merging into the Diagnostics dock. */
  diagnostics: Diagnostic[]
  /** Drive a line into a device to a level — a stand-in until M6 feeds real GPIO edges. */
  setSignal(partId: string, signal: string, level: 0 | 1): void
}

interface DevicesState {
  snapshots: Map<string, DeviceSnapshotMessage>
  events: Map<string, DeviceEventMessage['event'][]>
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

  const byPart = new Map<string, PartDeviceView>()
  for (const [partId, snapshot] of state.snapshots) {
    byPart.set(partId, { snapshot, events: state.events.get(partId) ?? [] })
  }
  for (const [partId, events] of state.events) {
    if (!byPart.has(partId)) byPart.set(partId, { snapshot: undefined, events })
  }

  return { byPart, diagnostics: state.diagnostics, setSignal }
}
