import type { PartDefinition } from '@shared/board'
import type { PartDeviceView } from '../state/useDevices'
import { EInkScreen } from './EInkScreen'
import { St7789Screen, isRgbPanel, isRoundPanel } from './St7789Screen'
import './outpanel.css'

interface OutPanelProps {
  part: PartDefinition
  view: PartDeviceView | undefined
  /** Drive a line into the model to a level. Present only for a drivable model. */
  onSetLevel?: ((signal: string, level: 0 | 1) => void) | undefined
  /** Live config values (the Inspector `values` map), keyed `partId.fieldId`. */
  configValues?: Record<string, string | number | boolean> | undefined
  /** Commit a config-field change — the Inspector's `applyConfig`, part-scoped. */
  onConfigChange?: ((fieldId: string, value: string | number | boolean) => void) | undefined
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
export function OutPanel({
  part,
  view,
  onSetLevel,
  configValues,
  onConfigChange
}: OutPanelProps): React.JSX.Element {
  const snapshot = view?.snapshot
  const isLed = part.deviceModel === 'pinbench.led'
  const isPanel = isRgbPanel(part.deviceModel)
  const isEInk = part.deviceModel === 'ultrachip.uc8151'
  const isButton = part.deviceModel === 'pinbench.button'
  const pressed = snapshot?.state['pressed'] === true
  const lit = snapshot?.state['lit'] === true
  const pinHigh = snapshot?.state['pin'] === 1
  const zoom = panelZoom(part, configValues)
  const rotate = panelRotate(part, configValues)

  return (
    <section className="inspector__section outpanel" aria-label="Output">
      <h4 className="inspector__section-title">Output</h4>

      {/* Config, not observed state — meaningful before any bus activity, and
          the design keeps them on the panel at all times. */}
      {(isPanel || isEInk) && onConfigChange && (
        <ScreenControls
          part={part}
          configValues={configValues}
          onConfigChange={onConfigChange}
          showBacklight={isPanel}
        />
      )}

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

          {isButton && (
            <div className="outpanel__led">
              <span
                className="outpanel__bulb"
                data-lit={pressed || undefined}
                aria-label={pressed ? 'Button pressed' : 'Button released'}
              />
              <span className="outpanel__bulb-label">{pressed ? 'PRESSED' : 'RELEASED'}</span>
            </div>
          )}

          {isPanel && (
            <St7789Screen
              framebuffer={view?.framebuffer}
              zoom={zoom}
              rotate={rotate}
              round={isRoundPanel(part.deviceModel)}
            />
          )}

          {isEInk && <EInkScreen framebuffer={view?.framebuffer} zoom={zoom} rotate={rotate} />}

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

/** A config field's live value (session edit) falling back to the board default. */
export function fieldValue(
  part: PartDefinition,
  configValues: Record<string, string | number | boolean> | undefined,
  fieldId: string
): string | number | boolean | undefined {
  const key = `${part.id}.${fieldId}`
  if (configValues && key in configValues) return configValues[key]
  return part.config.find((f) => f.id === fieldId)?.value
}

/** The "Rotation" segmented control (`0°`…`270°`) → degrees for the screen. */
export function panelRotate(
  part: PartDefinition,
  configValues?: Record<string, string | number | boolean>
): number {
  const raw = fieldValue(part, configValues, 'rotation')
  if (typeof raw === 'string') {
    const n = parseInt(raw, 10)
    if (n === 90 || n === 180 || n === 270) return n
  }
  return 0
}

/** The ST7789 "Panel zoom" segmented control → a pixel multiplier. */
function panelZoom(
  part: PartDefinition,
  configValues?: Record<string, string | number | boolean>
): number {
  const raw = fieldValue(part, configValues, 'scale')
  if (typeof raw === 'string') {
    const n = parseInt(raw, 10)
    if (n === 1 || n === 2 || n === 3) return n
  }
  return 2
}

/**
 * The design puts the panel-zoom picker, a `Rotation` picker and a `BL ON/OFF`
 * toggle on the screen OUT panel itself, not only in the Inspector's
 * Configuration list. These are a second surface onto the same
 * `scale` / `rotation` / `backlight` config fields — every click goes through
 * the Inspector's `onConfigChange`, so the two stay in lock-step.
 */
function ScreenControls({
  part,
  configValues,
  onConfigChange,
  showBacklight
}: {
  part: PartDefinition
  configValues: Record<string, string | number | boolean> | undefined
  onConfigChange: (fieldId: string, value: string | number | boolean) => void
  showBacklight: boolean
}): React.JSX.Element | null {
  const scale = part.config.find((f) => f.id === 'scale')
  const rotation = part.config.find((f) => f.id === 'rotation')
  const backlight = part.config.find((f) => f.id === 'backlight')
  const scaleValue = fieldValue(part, configValues, 'scale')
  const rotationValue = fieldValue(part, configValues, 'rotation')
  const blOn = fieldValue(part, configValues, 'backlight') === true

  const hasScale = scale?.kind === 'segmented'
  const hasRotation = rotation?.kind === 'segmented'
  if (!hasScale && !hasRotation && !(showBacklight && backlight)) return null

  return (
    <div className="outpanel__screen-controls">
      {scale && scale.kind === 'segmented' && (
        <div className="field__segmented" role="group" aria-label="Panel zoom">
          {scale.options.map((option) => (
            <button
              key={option}
              type="button"
              className="field__segment"
              aria-pressed={scaleValue === option}
              data-active={scaleValue === option || undefined}
              onClick={() => onConfigChange('scale', option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      {rotation && rotation.kind === 'segmented' && (
        <div className="field__segmented" role="group" aria-label="Rotation">
          {rotation.options.map((option) => (
            <button
              key={option}
              type="button"
              className="field__segment"
              aria-pressed={rotationValue === option}
              data-active={rotationValue === option || undefined}
              onClick={() => onConfigChange('rotation', option)}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      {showBacklight && backlight && (
        <button
          type="button"
          className="outpanel__bl"
          aria-pressed={blOn}
          data-on={blOn || undefined}
          onClick={() => onConfigChange('backlight', !blOn)}
        >
          BL {blOn ? 'ON' : 'OFF'}
        </button>
      )}
    </div>
  )
}

/** ns since emulator start → a compact `s.mmm` reading. */
function formatNs(t: number): string {
  const ms = t / 1e6
  if (ms < 1000) return `${ms.toFixed(1)}ms`
  return `${(ms / 1000).toFixed(3)}s`
}
