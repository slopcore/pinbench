import type { BoardDefinition, BoardTotals } from '@shared/board'
import type { EmulatorState } from '@shared/emulator'
import './statusbar.css'

export type { EmulatorState }

const EMULATOR_LABELS: Record<EmulatorState, string> = {
  idle: 'Emulator idle',
  starting: 'Starting…',
  running: 'Running',
  stopping: 'Stopping…',
  crashed: 'Crashed'
}

interface StatusBarProps {
  board: BoardDefinition
  totals: BoardTotals
  emulator: EmulatorState
  version: string
}

export function StatusBar({ board, totals, emulator, version }: StatusBarProps): React.JSX.Element {
  return (
    <footer className="statusbar">
      <span className="statusbar__board">{board.name}</span>
      <span className="statusbar__mcu">{board.mcu}</span>
      <span className="statusbar__spacer" />
      {/* Computed from the board definition, never written down. */}
      <span className="statusbar__totals">
        {totals.parts} parts · {totals.nets} nets · {totals.assignedGpio} GPIO assigned
      </span>
      <span className="statusbar__divider" />
      <span className="statusbar__emulator" data-state={emulator}>
        <span className="statusbar__dot" aria-hidden="true" />
        {EMULATOR_LABELS[emulator]}
      </span>
      <span className="statusbar__version">v{version}</span>
    </footer>
  )
}
