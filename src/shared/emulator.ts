export type EmulatorState = 'idle' | 'starting' | 'running' | 'stopping' | 'crashed'

export interface EmulatorStatus {
  state: EmulatorState
  /** Why the emulator entered the crashed state, if it did. */
  error?: string
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
