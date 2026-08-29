import { useEffect, useRef, useState } from 'react'
import type { BuildOutputLine } from '@shared/build'
import { isUsbFlashRunning, usbFlashButtonLabel } from '@shared/usb-flash'
import type { SerialPortInfo, UsbFlashMode, UsbFlashStatus } from '@shared/usb-flash'
import './usb-flash-dialog.css'

export interface UsbFlashDialogProps {
  open: boolean
  status: UsbFlashStatus
  log: BuildOutputLine[]
  ports: SerialPortInfo[]
  /** Null when no PlatformIO project is attached — flashing needs one. */
  projectName: string | null
  env: string | null
  onRefreshPorts: () => void
  onFlash: (port: string, mode: UsbFlashMode) => void
  onCancel: () => void
  onClose: () => void
}

export function UsbFlashDialog({
  open,
  status,
  log,
  ports,
  projectName,
  env,
  onRefreshPorts,
  onFlash,
  onCancel,
  onClose
}: UsbFlashDialogProps): React.JSX.Element | null {
  const [chosenPort, setChosenPort] = useState('')
  const [mode, setMode] = useState<UsbFlashMode>('flash')
  const logEndRef = useRef<HTMLDivElement>(null)
  const running = isUsbFlashRunning(status.state)

  // The effective selection: the user's pick while it is still plugged in,
  // else the first port. Derived, so the list changing needs no effect.
  const port =
    chosenPort && ports.some((p) => p.port === chosenPort) ? chosenPort : (ports[0]?.port ?? '')

  // Scan for ports each time the dialog opens.
  useEffect(() => {
    if (open) onRefreshPorts()
  }, [open, onRefreshPorts])

  useEffect(() => {
    logEndRef.current?.scrollIntoView?.({ block: 'end' })
  }, [log])

  if (!open) return null

  const hasProject = projectName !== null && env !== null
  const canFlash = hasProject && port !== '' && !running
  const erasing = mode === 'erase-flash'

  return (
    <div className="usbflash__overlay" role="presentation" onClick={running ? undefined : onClose}>
      <div
        className="usbflash"
        role="dialog"
        aria-modal="true"
        aria-label="Flash over USB"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="usbflash__head">
          <h2 className="usbflash__title">Flash over USB</h2>
          <button
            type="button"
            className="usbflash__close"
            aria-label="Close"
            disabled={running}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <p className="usbflash__sub">
          {hasProject ? (
            <>
              Rebuilds <strong>{env}</strong> from <strong>{projectName}</strong> for the real chip,
              then writes it to the attached board with esptool.
            </>
          ) : (
            <>
              Attach a PlatformIO project from Build &amp; flash first — USB flash builds from it.
            </>
          )}
        </p>

        <div className="usbflash__field">
          <label className="usbflash__label" htmlFor="usbflash-port">
            Serial port
          </label>
          <div className="usbflash__row">
            <select
              id="usbflash-port"
              className="usbflash__select"
              value={port}
              disabled={running || ports.length === 0}
              onChange={(event) => setChosenPort(event.target.value)}
            >
              {ports.length === 0 ? (
                <option value="">No serial devices found</option>
              ) : (
                ports.map((p) => (
                  <option key={p.port} value={p.port}>
                    {p.port}
                    {p.description ? ` — ${p.description}` : ''}
                  </option>
                ))
              )}
            </select>
            <button
              type="button"
              className="usbflash__ghost"
              disabled={running}
              onClick={onRefreshPorts}
            >
              Refresh
            </button>
          </div>
        </div>

        <fieldset className="usbflash__field" disabled={running}>
          <legend className="usbflash__label">Mode</legend>
          <label className="usbflash__mode">
            <input
              type="radio"
              name="usbflash-mode"
              checked={mode === 'flash'}
              onChange={() => setMode('flash')}
            />
            <span>
              <strong>Flash</strong> — write the firmware, keep saved settings (NVS).
            </span>
          </label>
          <label className="usbflash__mode">
            <input
              type="radio"
              name="usbflash-mode"
              checked={erasing}
              onChange={() => setMode('erase-flash')}
            />
            <span>
              <strong>Erase + flash</strong> — wipe the whole chip first, then write.
            </span>
          </label>
          {erasing && (
            <p className="usbflash__warn" role="alert">
              Erases everything on the chip, including the node&apos;s saved keys and identity
              (NVS). This cannot be undone.
            </p>
          )}
        </fieldset>

        {(log.length > 0 || running || status.state === 'failed') && (
          <div className="usbflash__log" aria-label="Flash output">
            {log.map((line, index) => (
              <div className="usbflash__logline" data-stream={line.stream} key={index}>
                {line.text || ' '}
              </div>
            ))}
            <div ref={logEndRef} aria-hidden="true" />
          </div>
        )}

        {status.state === 'flashing' && status.percent !== undefined && (
          <div
            className="usbflash__progress"
            role="progressbar"
            aria-valuenow={status.percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="usbflash__bar" style={{ width: `${status.percent}%` }} />
          </div>
        )}

        <footer className="usbflash__foot">
          <span className="usbflash__status" data-state={status.state} aria-live="polite">
            {status.state === 'failed' && status.error
              ? status.error
              : usbFlashButtonLabel(status.state)}
          </span>
          <span className="usbflash__spacer" />
          {running ? (
            <button type="button" className="usbflash__ghost" onClick={onCancel}>
              Cancel
            </button>
          ) : (
            <button type="button" className="usbflash__ghost" onClick={onClose}>
              Close
            </button>
          )}
          <button
            type="button"
            className="usbflash__primary"
            data-danger={erasing || undefined}
            disabled={!canFlash}
            onClick={() => onFlash(port, mode)}
          >
            {erasing ? 'Erase & flash' : 'Flash'}
          </button>
        </footer>
      </div>
    </div>
  )
}
