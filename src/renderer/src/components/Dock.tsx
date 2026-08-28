import { useCallback, useRef } from 'react'
import { MAX_DOCK_HEIGHT, MIN_DOCK_HEIGHT } from '@shared/workspace'
import type { DockTab } from '@shared/workspace'
import './dock.css'

/** A line of firmware console output. M2 fills this from UART0. */
export interface SerialLine {
  /** Milliseconds since emulator start. */
  t: number
  text: string
}

export type DiagnosticSeverity = 'error' | 'warn' | 'info' | 'note' | 'ok'

/** A row in the Diagnostics dock. M3 fills these from the compiler. */
export interface Diagnostic {
  id: string
  severity: DiagnosticSeverity
  message: string
  file?: string
  line?: number
}

interface DockProps {
  tab: DockTab
  height: number
  serial: SerialLine[]
  diagnostics: Diagnostic[]
  onSelectTab: (tab: DockTab) => void
  onResize: (height: number) => void
  onClose: () => void
}

const stamp = (milliseconds: number): string => {
  const seconds = Math.floor(milliseconds / 1000)
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${String(
    milliseconds % 1000
  ).padStart(3, '0')}`
}

export function Dock({
  tab,
  height,
  serial,
  diagnostics,
  onSelectTab,
  onResize,
  onClose
}: DockProps): React.JSX.Element {
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: height }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    onResize(drag.startHeight - (event.clientY - drag.startY))
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  // The keyboard has to be able to do everything the drag handle does.
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      const step = event.shiftKey ? 40 : 8
      if (event.key === 'ArrowUp') onResize(height + step)
      else if (event.key === 'ArrowDown') onResize(height - step)
      else return
      event.preventDefault()
    },
    [height, onResize]
  )

  return (
    <section className="dock" style={{ height }} aria-label="Dock">
      <div
        className="dock__resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize dock"
        aria-valuenow={height}
        aria-valuemin={MIN_DOCK_HEIGHT}
        aria-valuemax={MAX_DOCK_HEIGHT}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      />
      <div className="dock__tabs" role="tablist" aria-label="Dock panels">
        <button
          type="button"
          role="tab"
          className="tab"
          aria-selected={tab === 'serial'}
          data-active={tab === 'serial' || undefined}
          onClick={() => onSelectTab('serial')}
        >
          Serial monitor
        </button>
        <button
          type="button"
          role="tab"
          className="tab"
          aria-selected={tab === 'diagnostics'}
          data-active={tab === 'diagnostics' || undefined}
          onClick={() => onSelectTab('diagnostics')}
        >
          Diagnostics
          {diagnostics.length > 0 && <span className="tab__badge">{diagnostics.length}</span>}
        </button>
        <span className="dock__tabs-spacer" />
        <button type="button" className="dock__close" aria-label="Hide dock" onClick={onClose}>
          ×
        </button>
      </div>

      {tab === 'serial' ? (
        <div className="dock__body dock__body--serial" role="tabpanel" aria-label="Serial monitor">
          <ol className="serial">
            {serial.map((line, index) => (
              <li className="serial__line" key={`${line.t}-${index}`}>
                <span className="serial__stamp">{stamp(line.t)}</span>
                <span className="serial__text">{line.text}</span>
              </li>
            ))}
          </ol>
          <form
            className="serial__input"
            onSubmit={(event) => event.preventDefault()}
            aria-label="Serial input"
          >
            <span className="serial__prompt">›</span>
            <input
              type="text"
              disabled
              placeholder="Serial input needs a running emulator"
              aria-label="Send to firmware"
            />
          </form>
        </div>
      ) : (
        <div className="dock__body" role="tabpanel" aria-label="Diagnostics">
          <ul className="diagnostics">
            {diagnostics.map((row) => (
              <li className="diagnostic" key={row.id}>
                <span className="diagnostic__severity" data-severity={row.severity}>
                  {row.severity}
                </span>
                <span className="diagnostic__message">{row.message}</span>
                {row.file !== undefined && (
                  <span className="diagnostic__source">
                    {row.file}
                    {row.line !== undefined && `:${row.line}`}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
