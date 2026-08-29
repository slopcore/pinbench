import { CATEGORY_LABELS } from '@shared/board'
import type { BoardDefinition, PartConfigField, PartDefinition } from '@shared/board'
import { InPanel } from './InPanel'
import { OutPanel } from './OutPanel'
import type { PartDeviceView } from '../state/useDevices'
import './panels.css'

/** LR1110 Inspector fields wired straight to the model's `setParam` (M7.3). */
const LR1110_LIVE_FIELDS: Record<string, string> = {
  bw: 'bw',
  sf: 'sf',
  cr: 'cr',
  txPower: 'txPower'
}

interface InspectorProps {
  board: BoardDefinition
  part: PartDefinition | undefined
  /**
   * Config edits are local to the session in M1 — M12 routes them into the
   * running device models. The handler exists now so the controls are wired to
   * state rather than pretending.
   */
  values: Record<string, string | number | boolean>
  onConfigChange: (partId: string, fieldId: string, value: string | number | boolean) => void
  /** The selected part's device-model state, when a model is loaded for it. */
  device?: PartDeviceView | undefined
  /** Drive a signal into the selected part's model (LED stand-in until M6). */
  onSetLevel?: ((signal: string, level: 0 | 1) => void) | undefined
  /** Send an IN-panel command to the selected part's model (`onCommand`). */
  onCommand?: ((command: string, args?: Record<string, unknown>) => void) | undefined
}

/** UART rates read as baud; a clocked bus reads as a frequency. */
function formatBusRate(bus: BoardDefinition['buses'][number]): string {
  if (bus.clockHz === undefined) return ''
  if (bus.kind === 'uart') return `${bus.clockHz.toLocaleString('en-GB')} baud`
  if (bus.clockHz >= 1_000_000) return `${bus.clockHz / 1_000_000} MHz`
  return `${bus.clockHz / 1000} kHz`
}

function fieldValue(
  values: InspectorProps['values'],
  part: PartDefinition,
  field: PartConfigField
): string | number | boolean {
  return values[`${part.id}.${field.id}`] ?? field.value
}

export function Inspector({
  board,
  part,
  values,
  onConfigChange,
  device,
  onSetLevel,
  onCommand
}: InspectorProps): React.JSX.Element {
  /** Apply a config edit, and for the LR1110's live fields also poke the model. */
  const applyConfig = (partId: string, fieldId: string, value: string | number | boolean): void => {
    onConfigChange(partId, fieldId, value)
    if (part?.deviceModel === 'semtech.lr1110' && onCommand && LR1110_LIVE_FIELDS[fieldId]) {
      onCommand('setParam', { [LR1110_LIVE_FIELDS[fieldId]!]: value })
    }
  }
  return (
    <aside className="panel panel--inspector" aria-label="Inspector">
      <div className="panel__header">
        <h2 className="panel__title">Inspector</h2>
      </div>
      <div className="panel__body">
        {part === undefined ? (
          <div className="inspector__board">
            <p className="panel__empty">Select a part on the canvas or in the Library.</p>
            <dl className="inspector__facts">
              <dt>Board</dt>
              <dd>{board.name}</dd>
              <dt>MCU</dt>
              <dd>{board.mcu}</dd>
              <dt>Vendor</dt>
              <dd>{board.vendor}</dd>
              <dt>Buses</dt>
              <dd>{board.buses.map((bus) => bus.label).join(', ')}</dd>
            </dl>
          </div>
        ) : (
          <>
            <header className="inspector__heading">
              <span className="inspector__designator">{part.designator}</span>
              <h3 className="inspector__name">{part.name}</h3>
              {part.mpn !== undefined && <p className="inspector__mpn">{part.mpn}</p>}
              <p className="inspector__summary">{part.summary}</p>
              <span className="inspector__category">{CATEGORY_LABELS[part.category]}</span>
            </header>

            {part.config.length > 0 && (
              <section className="inspector__section">
                <h4 className="inspector__section-title">Configuration</h4>
                {part.config.map((field) => {
                  const value = fieldValue(values, part, field)
                  const change = (next: string | number | boolean): void =>
                    applyConfig(part.id, field.id, next)
                  return (
                    <div className="field" key={field.id}>
                      <span className="field__label">{field.label}</span>
                      {field.kind === 'segmented' && (
                        <div className="field__segmented" role="group" aria-label={field.label}>
                          {field.options.map((option) => (
                            <button
                              key={option}
                              type="button"
                              className="field__segment"
                              aria-pressed={value === option}
                              data-active={value === option || undefined}
                              onClick={() => change(option)}
                            >
                              {option}
                            </button>
                          ))}
                        </div>
                      )}
                      {field.kind === 'toggle' && (
                        <button
                          type="button"
                          className="field__toggle"
                          role="switch"
                          aria-checked={value === true}
                          aria-label={field.label}
                          data-on={value === true || undefined}
                          onClick={() => change(!(value === true))}
                        >
                          <span className="field__toggle-knob" />
                        </button>
                      )}
                      {field.kind === 'number' && (
                        <span className="field__number">
                          <input
                            type="range"
                            min={field.min}
                            max={field.max}
                            step={field.step}
                            value={Number(value)}
                            aria-label={field.label}
                            onChange={(event) => change(Number(event.target.value))}
                          />
                          <output className="field__readout">
                            {Number(value)}
                            {field.unit !== undefined && ` ${field.unit}`}
                          </output>
                        </span>
                      )}
                      {field.kind === 'text' && (
                        <input
                          type="text"
                          className="field__text"
                          value={String(value)}
                          aria-label={field.label}
                          onChange={(event) => change(event.target.value)}
                        />
                      )}
                    </div>
                  )
                })}
              </section>
            )}

            {part.pins.length > 0 && (
              <section className="inspector__section">
                <h4 className="inspector__section-title">Pin map</h4>
                <table className="pin-table">
                  <thead>
                    <tr>
                      <th scope="col">Signal</th>
                      <th scope="col">Pin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {part.pins.map((binding) => (
                      <tr key={binding.signal}>
                        <td>{binding.signal}</td>
                        <td className="pin-table__pin">{binding.pin}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            {part.buses.length > 0 && (
              <section className="inspector__section">
                <h4 className="inspector__section-title">Buses</h4>
                <ul className="inspector__buses">
                  {part.buses.map((busId) => {
                    const bus = board.buses.find((candidate) => candidate.id === busId)
                    if (!bus) return null
                    return (
                      <li key={busId}>
                        <span className="inspector__bus-label">{bus.label}</span>
                        {bus.clockHz !== undefined && (
                          <span className="inspector__bus-clock">{formatBusRate(bus)}</span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}

            {part.deviceModel !== undefined && onCommand && (
              <InPanel part={part} onCommand={onCommand} />
            )}

            {part.deviceModel !== undefined && (
              <OutPanel part={part} view={device} {...(onSetLevel ? { onSetLevel } : {})} />
            )}
          </>
        )}
      </div>
    </aside>
  )
}
