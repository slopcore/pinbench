import type { PartDefinition } from '@shared/board'
import type { PartDeviceView } from '../state/useDevices'
import { EInkScreen } from './EInkScreen'
import { St7789Screen } from './St7789Screen'
import './outpanel.css'

interface OutPanelProps {
  part: PartDefinition
  view: PartDeviceView | undefined
  /** Drive a line into the model to a level. Present only for a drivable model. */
  onSetLevel?: (signal: string, level: 0 | 1) => void
}

/**
 * A part's OUT panel — the observation side of a device model, rendered under
 * the Inspector's configuration. Generic for any model (meters + event log),
 * with a bespoke indicator for the LED so M4's "rendered LED blinks" is
 * literally on screen.
 *
 * Until M6 wires GPIO/SPI observation into the fork, the LED's line is driven
 * by the "Toggle" control rather than by firmware; every edge is timestamped in
 * the log so it stays honest about where it came from.
 */
export function OutPanel({ part, view, onSetLevel }: OutPanelProps): React.JSX.Element {
  const snapshot = view?.snapshot
  const isLed = part.deviceModel === 'pinbench.led'
  const isPanel = part.deviceModel === 'sitronix.st7789'
  const isEInk = part.deviceModel === 'solomon.ssd1680'
  const lit = snapshot?.state['lit'] === true
  const pinHigh = snapshot?.state['pin'] === 1
  const zoom = panelZoom(part)

  return (
    <section className="inspector__section outpanel" aria-label="Output">
      <h4 className="inspector__section-title">Output</h4>

      {snapshot === undefined ? (
        <p className="panel__empty">
          {part.deviceModel
            ? 'Model loaded — waiting for bus activity.'
            : 'No device model for this part yet.'}
        </p>
      ) : (
        <>
          {snapshot.quarantined && (
            <p className="outpanel__quarantine" role="status">
              Model quarantined after an error — reset to re-enable.
            </p>
          )}

          {isLed && (
            <div className="outpanel__led">
              <span
                className="outpanel__bulb"
                data-lit={lit || undefined}
                aria-label={lit ? 'LED lit' : 'LED dark'}
              />
              <span className="outpanel__bulb-label">{lit ? 'ON' : 'OFF'}</span>
              {onSetLevel && (
                <button
                  type="button"
                  className="outpanel__pulse"
                  onClick={() => onSetLevel('ANODE', pinHigh ? 0 : 1)}
                >
                  {pinHigh ? 'Drive low' : 'Drive high'}
                </button>
              )}
            </div>
          )}

          {isPanel && <St7789Screen framebuffer={view?.framebuffer} zoom={zoom} />}

          {isEInk && <EInkScreen framebuffer={view?.framebuffer} zoom={zoom} />}

          {snapshot.meters.length > 0 && (
            <dl className="outpanel__meters">
              {snapshot.meters.map((meter) => (
                <div className="outpanel__meter" key={meter.id}>
                  <dt>{meter.label}</dt>
                  <dd>
                    {meter.value ?? '—'}
                    {meter.unit !== undefined && meter.value !== undefined ? ` ${meter.unit}` : ''}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          <ol className="outpanel__log">
            {(view?.events ?? [])
              .slice(-8)
              .reverse()
              .map((event, index) => (
                <li key={`${event.t}-${index}`}>
                  <span className="outpanel__log-t">{formatNs(event.t)}</span>
                  <span className="outpanel__log-msg">{event.summary}</span>
                </li>
              ))}
            {(view?.events ?? []).length === 0 && (
              <li className="outpanel__log-empty">No events yet.</li>
            )}
          </ol>
        </>
      )}
    </section>
  )
}

/** The ST7789 "Panel zoom" segmented control → a pixel multiplier. */
function panelZoom(part: PartDefinition): number {
  const field = part.config.find((f) => f.id === 'scale')
  if (field && field.kind === 'segmented') {
    const n = parseInt(field.value, 10)
    if (n === 1 || n === 2 || n === 3) return n
  }
  return 2
}

/** ns since emulator start → a compact `s.mmm` reading. */
function formatNs(t: number): string {
  const ms = t / 1e6
  if (ms < 1000) return `${ms.toFixed(1)}ms`
  return `${(ms / 1000).toFixed(3)}s`
}
