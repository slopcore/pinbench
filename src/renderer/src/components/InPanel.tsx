import { useEffect, useState } from 'react'
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
 * Four renderers: the LoRa transceivers (LR1110, SX1262) share a hand-built
 * RSSI/SNR frame-injection panel, the keyboard coprocessor gets a key matrix,
 * the TWN4 RFID reader gets a card UID/type form, and every other model with a stimulus set in `shared/stimuli.ts` gets a
 * generic button panel. A model with none renders nothing.
 */
const RADIO_MODELS = new Set(['semtech.lr1110', 'semtech.sx1262'])

export function InPanel({ part, onCommand }: InPanelProps): React.JSX.Element | null {
  if (part.deviceModel && RADIO_MODELS.has(part.deviceModel)) {
    return <RadioInPanel onCommand={onCommand} />
  }
  if (part.deviceModel === 'pinbench.kbd-coprocessor') {
    return <KeyboardInPanel onCommand={onCommand} />
  }
  if (part.deviceModel === 'elatec.twn4') {
    return <RfidInPanel onCommand={onCommand} />
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

const LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit'

function RadioInPanel({ onCommand }: { onCommand: InPanelProps['onCommand'] }): React.JSX.Element {
  const [text, setText] = useState(LOREM)
  const [rssi, setRssi] = useState(-80)
  const [snr, setSnr] = useState(7)
  const [floor, setFloor] = useState(-100)
  // The recipient node's identity key for a `direct` message. Auto-filled when
  // the main process learns it from a booted companion guest; editable so it
  // works for firmware where discovery can't (e.g. the BLE companion variant).
  const [recipientKey, setRecipientKey] = useState('')
  useEffect(() => window.pinbench?.devices?.onMeshIdentity?.((key) => setRecipientKey(key)), [])

  const keyValid = /^[0-9a-fA-F]{64}$/.test(recipientKey.trim())
  const inject = (kind: string, extra: Record<string, unknown> = {}): void => {
    const guestPub = kind === 'direct' && keyValid ? { guestPub: recipientKey.trim() } : {}
    onCommand('inject', { kind, rssi, snr, ...guestPub, ...extra })
  }

  return (
    <section className="inspector__section outpanel" aria-label="Input">
      <h4 className="inspector__section-title">Input</h4>

      <label className="inpanel__field">
        <span>Message text</span>
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Message text"
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

      <label className="inpanel__field">
        <span>Recipient key</span>
        <input
          type="text"
          value={recipientKey}
          onChange={(e) => setRecipientKey(e.target.value)}
          placeholder="auto (from booted companion)"
          aria-label="Recipient key"
          aria-invalid={recipientKey.trim() !== '' && !keyValid}
        />
      </label>

      <div className="inpanel__buttons">
        <button type="button" onClick={() => inject('channel', { text })}>
          Send channel
        </button>
        <button type="button" onClick={() => inject('direct', { text })}>
          Send direct
        </button>
      </div>

      <div className="inpanel__buttons">
        <button type="button" onClick={() => inject('pair')}>
          Pair sender
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

/** Tag types offered in the RFID panel — names the TWN4 model accepts. */
const RFID_TAG_TYPES = [
  ['mifare', 'MIFARE / ISO 14443A (13.56 MHz)'],
  ['iso15693', 'ISO 15693 (13.56 MHz)'],
  ['hidiclass', 'HID iCLASS (13.56 MHz)'],
  ['legic', 'LEGIC (13.56 MHz)'],
  ['em4102', 'EM4102 (125 kHz)'],
  ['hidprox', 'HID Prox (125 kHz)']
] as const

const RFID_PRESETS: ReadonlyArray<{ label: string; uid: string; type: string }> = [
  { label: 'MIFARE Classic 1K', uid: '04A1B2C3', type: 'mifare' },
  { label: 'NTAG215 (7-byte)', uid: '04112233445566', type: 'mifare' },
  { label: 'EM4102 fob', uid: '1A2B3C4D5E', type: 'em4102' }
]

function RfidInPanel({ onCommand }: { onCommand: InPanelProps['onCommand'] }): React.JSX.Element {
  const [uid, setUid] = useState('04A1B2C3')
  const [type, setType] = useState<string>('mifare')
  const uidValid = /^([0-9a-fA-F]{2}){1,16}$/.test(uid.trim())

  return (
    <section className="inspector__section outpanel" aria-label="Input">
      <h4 className="inspector__section-title">Input</h4>

      <div className="inpanel__rowfields">
        <label className="inpanel__field">
          <span>Card UID (hex)</span>
          <input
            type="text"
            value={uid}
            onChange={(e) => setUid(e.target.value)}
            aria-label="Card UID"
            aria-invalid={!uidValid}
          />
        </label>
        <label className="inpanel__field">
          <span>Tag type</span>
          <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Tag type">
            {RFID_TAG_TYPES.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="inpanel__buttons">
        <button
          type="button"
          disabled={!uidValid}
          onClick={() => onCommand('present', { uid: uid.trim(), type })}
        >
          Present card
        </button>
        <button type="button" onClick={() => onCommand('remove')}>
          Remove card
        </button>
      </div>

      <span className="inpanel__group-title">Presets</span>
      <div className="inpanel__buttons">
        {RFID_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => {
              setUid(preset.uid)
              setType(preset.type)
              onCommand('present', { uid: preset.uid, type: preset.type })
            }}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </section>
  )
}
