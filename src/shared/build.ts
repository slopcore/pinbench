/**
 * The build pipeline's state machine.
 *
 * Mirrors `emulator.ts`: a small typed transition table, pure, unit-testable
 * without a child process. The renderer turns these states into the design's
 * cycling button label (`Compiling… → Linking… → Flashed ✓`).
 */

export type BuildState =
  'idle' | 'preparing' | 'compiling' | 'linking' | 'merging' | 'done' | 'failed' | 'cancelled'

export interface BuildStatus {
  state: BuildState
  /** Environment being built, once one is chosen. */
  env?: string
  /** Why the build entered `failed`, if it did. */
  error?: string
  /** Path to the merged flash image, set when `done`. */
  image?: string
  /** Whether the artifact came from cache rather than a fresh compile. */
  cached?: boolean
}

const VALID_TRANSITIONS: Record<BuildState, BuildState[]> = {
  idle: ['preparing'],
  preparing: ['compiling', 'linking', 'merging', 'done', 'failed', 'cancelled'],
  compiling: ['linking', 'merging', 'done', 'failed', 'cancelled'],
  linking: ['merging', 'compiling', 'done', 'failed', 'cancelled'],
  merging: ['done', 'failed', 'cancelled'],
  done: ['preparing'],
  failed: ['preparing'],
  cancelled: ['preparing']
}

export function canTransition(from: BuildState, to: BuildState): boolean {
  return from === to || VALID_TRANSITIONS[from].includes(to)
}

export function transition(from: BuildState, to: BuildState): BuildState {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid build transition: ${from} → ${to}`)
  }
  return to
}

export const INITIAL_BUILD_STATUS: BuildStatus = { state: 'idle' }

export type BuildStream = 'stdout' | 'stderr'

export interface BuildOutputLine {
  stream: BuildStream
  text: string
  /**
   * True when this line replaces the previous one rather than appending — a
   * carriage-return progress update (toolchain download, size check). The
   * renderer overwrites its last row instead of growing the log.
   */
  replace: boolean
}

const PHASE_MARKERS: { re: RegExp; state: BuildState }[] = [
  { re: /^Compiling\s/, state: 'compiling' },
  { re: /^Linking\s/, state: 'linking' },
  { re: /^Building\s.*\.bin\b/, state: 'linking' },
  { re: /^Retrieving maximum program size/, state: 'linking' },
  { re: /^Checking size/, state: 'linking' }
]

/**
 * Map a line of `pio run` output to the build phase it announces, or null when
 * the line says nothing about progress.
 */
export function phaseFromLine(line: string): BuildState | null {
  const trimmed = line.trimStart()
  for (const marker of PHASE_MARKERS) {
    if (marker.re.test(trimmed)) return marker.state
  }
  return null
}

const BUTTON_LABELS: Record<BuildState, string> = {
  idle: 'Build & flash',
  preparing: 'Preparing…',
  compiling: 'Compiling…',
  linking: 'Linking…',
  merging: 'Flashing…',
  done: 'Flashed ✓',
  failed: 'Build failed',
  cancelled: 'Build & flash'
}

export function buildButtonLabel(state: BuildState): string {
  return BUTTON_LABELS[state]
}

export function isBuildRunning(state: BuildState): boolean {
  return (
    state === 'preparing' || state === 'compiling' || state === 'linking' || state === 'merging'
  )
}
