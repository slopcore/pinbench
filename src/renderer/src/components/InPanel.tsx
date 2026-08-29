import { useState } from 'react'
import type { PartDefinition } from '@shared/board'
import { stimuliFor } from '@shared/stimuli'
import './outpanel.css'

interface InPanelProps {
  part: PartDefinition
  /** Send a command to the part's model `onCommand`. */
  onCommand: (command: string, args?: Record<string, unknown>) => void
}

/**
 * The input side of a device model — stimuli the operator injects.
 *
 * Three renderers: the LR1110 keeps its hand-built RSSI/SNR panel, the keyboard
 * coprocessor gets a key matrix, and every other model with a stimulus set in
 * `shared/stimuli.ts` gets a generic button panel. A model with none renders
 * nothing.
 */
export function InPanel({ part, onCommand }: InPanelProps): React.JSX.Element | null {
  if (part.deviceModel === 'semtech.lr1110') return <Lr1110InPanel onCommand={onCommand} />
  if (part.deviceModel === 'pinbench.kbd-coprocessor') {
    return <KeyboardInPanel onCommand={onCommand} />
  }
  const groups = stimuliFor(part.deviceModel)
  if (groups.length === 0) return null
  return (
    <section className="inspector__section outpanel" aria-label="Input">
      <h4 className="inspector__section-title">Input</h4>
      {groups.map((group) => (
        <div className="inpanel__group" key={group.title}>
          <span className="inpanel__group-title">{group.title}</span>
          <div className="inpanel__buttons">
            {group.buttons.map((button) => (
              <button
                key={button.label}
                type="button"
                onClick={() => onCommand(button.command, button.args)}
              >
                {button.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}

function Lr1110InPanel({ onCommand }: { onCommand: InPanelProps['onCommand'] }): React.JSX.Element {
  const [text, setText] = useState('trailhead in 20')
  const [rssi, setRssi] = useState(-80)
  const [snr, setSnr] = useState(7)
  const [floor, setFloor] = useState(-100)

  const inject = (kind: string, extra: Record<string, unknown> = {}): void =>
    onCommand('inject', { kind, rssi, snr, ...extra })

  return (
    <section className="inspector__section outpanel" aria-label="Input">
      <h4 className="inspector__section-title">Input</h4>

      <label className="inpanel__field">
        <span>Channel message</span>
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Channel message text"
        />
      </label>

      <div className="inpanel__rowfields">
        <label className="inpanel__field">
          <span>RSSI dBm</span>
          <input
            type="number"
            value={rssi}
            onChange={(e) => setRssi(Number(e.target.value))}
            aria-label="RSSI dBm"
          />
        </label>
        <label className="inpanel__field">
          <span>SNR dB</span>
          <input
            type="number"
            value={snr}
            onChange={(e) => setSnr(Number(e.target.value))}
            aria-label="SNR dB"
          />
        </label>
      </div>

      <div className="inpanel__buttons">
        <button type="button" onClick={() => inject('channel', { text })}>
          Channel message
        </button>
        <button type="button" onClick={() => inject('advert', { hops: 2 })}>
          Node advert
        </button>
        <button type="button" onClick={() => inject('ack')}>
          Delivery ack
        </button>
      </div>

      <div className="inpanel__buttons">
        <label className="inpanel__field">
          <span>Noise floor dBm</span>
          <input
            type="number"
            value={floor}
            onChange={(e) => setFloor(Number(e.target.value))}
            aria-label="Noise floor dBm"
          />
        </label>
        <button type="button" onClick={() => onCommand('inject', { kind: 'noise', floor })}>
          Noise burst
        </button>
      </div>
    </section>
  )
}

// The M9 keyboard: four QWERTY rows, a D-pad, the six shortcut keys, and a
// readout of what the coprocessor has buffered. Every key sends `key`.
const KEY_ROWS = [
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
  ['Z', 'X', 'C', 'V', 'B', 'N', 'M'],
  ['SYM', 'SPACE', 'ENTER', 'BKSP']
]
const DPAD = ['UP', 'DOWN', 'LEFT', 'RIGHT', 'OK']
const SHORTCUTS = ['HOME', 'BACK', 'MENU', 'CHAT', 'MAP', 'LOC']

function KeyboardInPanel({
  onCommand
}: {
  onCommand: InPanelProps['onCommand']
}): React.JSX.Element {
  const [buffer, setBuffer] = useState('')

  const press = (key: string): void => {
    onCommand('key', { key })
    setBuffer((previous) => {
      const next =
        key === 'BKSP'
          ? previous.slice(0, -1)
          : key === 'SPACE'
            ? `${previous} `
            : key === 'ENTER'
              ? `${previous}⏎`
              : key.length === 1
                ? previous + key
                : previous
      return next.slice(-32)
    })
  }

  return (
    <section className="inspector__section outpanel" aria-label="Input">
      <h4 className="inspector__section-title">Input</h4>

      <div className="kbd">
        {KEY_ROWS.map((row, index) => (
          <div className="kbd__row" key={index}>
            {row.map((key) => (
              <button
                key={key}
                type="button"
                className="kbd__key"
                data-wide={key.length > 1 || undefined}
                onClick={() => press(key)}
              >
                {key}
              </button>
            ))}
          </div>
        ))}
      </div>

      <span className="inpanel__group-title">D-pad</span>
      <div className="kbd__dpad">
        {DPAD.map((key) => (
          <button key={key} type="button" className="kbd__key" onClick={() => press(key)}>
            {key}
          </button>
        ))}
      </div>

      <span className="inpanel__group-title">Shortcut keys</span>
      <div className="inpanel__buttons">
        {SHORTCUTS.map((key) => (
          <button key={key} type="button" onClick={() => press(key)}>
            {key}
          </button>
        ))}
      </div>

      <label className="inpanel__field">
        <span>Key buffer</span>
        <output className="kbd__buffer">{buffer || '—'}</output>
      </label>
    </section>
  )
}
