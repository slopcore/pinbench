import { useState } from 'react'
import type { PartDefinition } from '@shared/board'
import './outpanel.css'

interface InPanelProps {
  part: PartDefinition
  /** Send a command to the part's model `onCommand`. */
  onCommand: (command: string, args?: Record<string, unknown>) => void
}

/**
 * The input side of a device model — stimuli the operator injects. M7 wires the
 * LR1110's: a node advert, a channel message, a delivery ack, and a
 * noise-floor burst. Each carries the RSSI/SNR the OUT panel then reports.
 *
 * Generic models get nothing here; only ids with a known stimulus set render a
 * panel (the keyboard's matrix joins in M8).
 */
export function InPanel({ part, onCommand }: InPanelProps): React.JSX.Element | null {
  if (part.deviceModel !== 'semtech.lr1110') return null
  return <Lr1110InPanel onCommand={onCommand} />
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
