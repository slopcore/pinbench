/**
 * The device-host → renderer message shapes, crossing the preload bridge.
 *
 * Kept here rather than in `src/main/devices.ts` so the preload and renderer
 * can import them without pulling in `node:net`. The host produces them; the
 * OUT panels consume them.
 */

import type { DeviceEvent } from './model'

/** One part's observable state, pushed whenever it changes. */
export interface DeviceSnapshotMessage {
  partId: string
  deviceModel: string
  designator: string
  name: string
  /** Structured-clonable model state. */
  state: Record<string, unknown>
  /** Declared meters resolved to their current values. */
  meters: DeviceMeterValue[]
  /** True once the model threw and was quarantined until reset. */
  quarantined: boolean
}

export interface DeviceMeterValue {
  id: string
  label: string
  unit?: string
  value: number | undefined
}

/** One row for a part's OUT-panel event log. */
export interface DeviceEventMessage {
  partId: string
  event: DeviceEvent & { t: number }
}

/** A command from an IN panel, renderer → host (wired from M7). */
export interface DeviceCommandMessage {
  partId: string
  command: string
  args?: Record<string, unknown>
}
