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
  /** Board ids on disk; a picker is shown when there is more than one. */
  availableBoards: string[]
  onSelectBoard: (id: string) => void
  totals: BoardTotals
  /** First serial port `pio device list` sees, or null when none is attached. */
  port: string | null
  emulator: EmulatorState
  version: string
}

export function StatusBar({
  board,
  availableBoards,
  onSelectBoard,
  totals,
  port,
  emulator,
  version
}: StatusBarProps): React.JSX.Element {
  return (
    <footer className="statusbar">
      {availableBoards.length > 1 ? (
        <select
          className="statusbar__board statusbar__board-picker"
          aria-label="Board"
          value={board.id}
          onChange={(event) => onSelectBoard(event.target.value)}
        >
          {availableBoards.map((id) => (
            <option key={id} value={id}>
              {id === board.id ? board.name : id}
            </option>
          ))}
        </select>
      ) : (
        <span className="statusbar__board">{board.name}</span>
      )}
      <span className="statusbar__mcu">{board.mcu}</span>
      <span className="statusbar__port" title="Attached serial port">
        {port ?? 'no port'}
      </span>
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
