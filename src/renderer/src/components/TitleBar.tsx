import { MenuBar } from './MenuBar'
import type { CommandId } from '@shared/commands'
import type { WindowState } from '@shared/ipc'
import './titlebar.css'

interface TitleBarProps {
  platform: NodeJS.Platform
  title: string
  subtitle: string
  windowState: WindowState
  onCommand: (command: CommandId) => void
  isChecked: (command: CommandId) => boolean
}

export function TitleBar({
  platform,
  title,
  subtitle,
  windowState,
  onCommand,
  isChecked
}: TitleBarProps): React.JSX.Element {
  const mac = platform === 'darwin'
  return (
    <header className="titlebar" data-focused={windowState.focused || undefined}>
      {/* On macOS the traffic lights are drawn by the OS over our bar, so the
          menu bar starts clear of them. */}
      {mac && !windowState.fullScreen && <div className="titlebar__traffic-lights" />}
      <MenuBar platform={platform} onCommand={onCommand} isChecked={isChecked} />
      <div className="titlebar__title">
        <span className="titlebar__document">{title}</span>
        <span className="titlebar__subtitle">{subtitle}</span>
      </div>
      {mac ? (
        <div className="titlebar__spacer" />
      ) : (
        <div className="titlebar__window-controls">
          <button
            type="button"
            className="window-control"
            aria-label="Minimise"
            onClick={() => window.pinbench.window.minimise()}
          >
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <path d="M0 5h10" />
            </svg>
          </button>
          <button
            type="button"
            className="window-control"
            aria-label={windowState.maximised ? 'Restore' : 'Maximise'}
            onClick={() => window.pinbench.window.toggleMaximise()}
          >
            <svg viewBox="0 0 10 10" aria-hidden="true">
              {windowState.maximised ? (
                <path d="M2.5 2.5V0.5h7v7h-2M0.5 2.5h7v7h-7z" />
              ) : (
                <path d="M0.5 0.5h9v9h-9z" />
              )}
            </svg>
          </button>
          <button
            type="button"
            className="window-control window-control--close"
            aria-label="Close"
            onClick={() => window.pinbench.window.close()}
          >
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
            </svg>
          </button>
        </div>
      )}
    </header>
  )
}
