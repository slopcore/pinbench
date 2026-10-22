import { useEffect } from 'react'
import { MENUS, formatAccelerator, menuItems } from '@shared/commands'
import type { AppInfo } from '@shared/ipc'
import './help-sheet.css'

export type HelpSheetKind = 'shortcuts' | 'about'

interface HelpSheetProps {
  kind: HelpSheetKind | null
  platform: NodeJS.Platform
  appInfo: AppInfo
  onClose: () => void
}

/**
 * The two Help items the menu shipped without a handler. The shortcuts list is
 * built from the shared command table so it cannot drift from the real
 * accelerators; About reads the same `AppInfo` the status bar shows.
 */
export function HelpSheet({
  kind,
  platform,
  appInfo,
  onClose
}: HelpSheetProps): React.JSX.Element | null {
  useEffect(() => {
    if (!kind) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [kind, onClose])

  if (!kind) return null

  return (
    <div className="help-sheet__scrim" role="presentation" onClick={onClose}>
      <div
        className="help-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={kind === 'shortcuts' ? 'Keyboard shortcuts' : 'About PinBench'}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="help-sheet__header">
          <h2>{kind === 'shortcuts' ? 'Keyboard shortcuts' : 'About PinBench'}</h2>
          <button type="button" className="help-sheet__close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        {kind === 'shortcuts' ? (
          <div className="help-sheet__body">
            {MENUS.map((menu) => {
              const rows = menuItems(menu).filter((entry) => entry.accelerator !== undefined)
              if (rows.length === 0) return null
              return (
                <section className="help-sheet__group" key={menu.id}>
                  <h3>{menu.label}</h3>
                  <dl>
                    {rows.map((entry) => (
                      <div className="help-sheet__row" key={entry.command}>
                        <dt>{entry.label}</dt>
                        <dd>
                          <kbd>{formatAccelerator(entry.accelerator!, platform)}</kbd>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )
            })}
          </div>
        ) : (
          <div className="help-sheet__body help-sheet__about">
            <p className="help-sheet__product">PinBench</p>
            <dl>
              <div className="help-sheet__row">
                <dt>Version</dt>
                <dd>{appInfo.version}</dd>
              </div>
              <div className="help-sheet__row">
                <dt>Platform</dt>
                <dd>{appInfo.platform}</dd>
              </div>
              <div className="help-sheet__row">
                <dt>Build</dt>
                <dd>{appInfo.isDev ? 'development' : 'production'}</dd>
              </div>
            </dl>
            <p className="help-sheet__blurb">
              A cross-platform desktop workbench for embedded mesh-radio boards.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
