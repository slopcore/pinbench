export type EmulatorState = 'idle' | 'starting' | 'running' | 'stopping' | 'crashed'

export interface EmulatorStatus {
  state: EmulatorState
  /** Why the emulator entered the crashed state, if it did. */
  error?: string
}

/**
 * Machine and memory options for a launch. M2 hardcoded these; from M3 they
 * come from the board definition's `emulator` target so a second board with
 * different PSRAM is data, not a code change. No `psramSize` means no `-m`,
 * and therefore silently no PSRAM.
 */
export interface EmulatorLaunchOptions {
  machine?: string
  psramSize?: string
  psramOctal?: boolean
  /** Total flash-image size (e.g. `16M`); sizes the merged Build & flash image. */
  flashSize?: string
}

export const DEFAULT_LAUNCH_OPTIONS: EmulatorLaunchOptions = {
  machine: 'esp32s3',
  psramSize: '8M',
  psramOctal: true
}

const VALID_TRANSITIONS: Record<EmulatorState, EmulatorState[]> = {
  idle: ['starting'],
  starting: ['running', 'crashed', 'stopping'],
  running: ['stopping', 'crashed'],
  stopping: ['idle', 'crashed'],
  crashed: ['starting', 'idle']
}

export function canTransition(from: EmulatorState, to: EmulatorState): boolean {
  return VALID_TRANSITIONS[from].includes(to)
}

export function transition(from: EmulatorState, to: EmulatorState): EmulatorState {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid emulator transition: ${from} → ${to}`)
  }
  return to
}

export const INITIAL_STATUS: EmulatorStatus = { state: 'idle' }
