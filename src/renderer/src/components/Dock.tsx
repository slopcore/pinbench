import { useCallback, useEffect, useRef, useState } from 'react'
import type { SerialLine } from '@shared/serial'
import type { EmulatorState } from '@shared/emulator'
import type { BuildOutputLine, BuildStatus } from '@shared/build'
import { isBuildRunning } from '@shared/build'
import type { Diagnostic, DiagnosticSeverity } from '@shared/diagnostics'
import type { FirmwareAction } from '@shared/actions'
import { MAX_DOCK_HEIGHT, MIN_DOCK_HEIGHT } from '@shared/workspace'
import type { DockTab } from '@shared/workspace'
import { AgentPanel } from './AgentPanel'
import type { AgentHandle } from '../state/useAgent'
import './dock.css'

export type { SerialLine }
export type { Diagnostic, DiagnosticSeverity }

interface DockProps {
  tab: DockTab
  height: number
  /** Shrunk to the tab strip (the design's collapse chevron). */
  collapsed: boolean
  serial: SerialLine[]
  diagnostics: Diagnostic[]
  /** Required firmware changes, mirrored to the IDE (`firmware_actions`, `.pinbench/actions.md`). */
  firmwareActions: FirmwareAction[]
  buildLog: BuildOutputLine[]
  buildStatus: BuildStatus
  emulatorState: EmulatorState
  /** The agent control plane. When `agent.state.enabled`, the Agent tab appears. */
  agent?: AgentHandle
  onSelectTab: (tab: DockTab) => void
  onResize: (height: number) => void
  onToggleCollapsed: () => void
  onClose: () => void
  onSerialSubmit: (text: string) => void
  /** Open a diagnostic's file:line in the external editor. */
  onOpenInEditor: (file: string, line?: number, column?: number) => void
}

const stamp = (milliseconds: number): string => {
  const seconds = Math.floor(milliseconds / 1000)
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${String(
    milliseconds % 1000
  ).padStart(3, '0')}`
}

const shortPath = (path: string): string => {
  const parts = path.split(/[/\\]/)
  return parts.length <= 3 ? path : `…/${parts.slice(-3).join('/')}`
}

export function Dock({
  tab,
  height,
  collapsed,
  serial,
  diagnostics,
  firmwareActions,
  buildLog,
  buildStatus,
  emulatorState,
  agent,
  onSelectTab,
  onResize,
  onToggleCollapsed,
  onClose,
  onSerialSubmit,
  onOpenInEditor
}: DockProps): React.JSX.Element {
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null)
  const serialEndRef = useRef<HTMLLIElement>(null)
  const buildEndRef = useRef<HTMLLIElement>(null)
  const scrollLocked = useRef(false)
  const listRef = useRef<HTMLOListElement>(null)
  const [inputValue, setInputValue] = useState('')

  // Autoscroll: follow output unless the user has scrolled up.
  useEffect(() => {
    if (!scrollLocked.current) {
      serialEndRef.current?.scrollIntoView?.({ block: 'end' })
    }
  }, [serial])

  // `tab` is a dep so switching *to* the console tab lands at the transcript's
  // tail — the panel is unmounted while another tab is active, so a `buildLog`
  // change alone never scrolls it.
  useEffect(() => {
    buildEndRef.current?.scrollIntoView?.({ block: 'end' })
  }, [buildLog, tab])

  const onScroll = useCallback(() => {
    const list = listRef.current
    if (!list) return
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24
    scrollLocked.current = !atBottom
  }, [])

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

  const handleSerialSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!inputValue.trim()) return
    onSerialSubmit(inputValue)
    setInputValue('')
  }

  const isRunning = emulatorState === 'running'
  const buildRunning = isBuildRunning(buildStatus.state)
  const showBuildLog = buildLog.length > 0 || buildRunning
  const agentEnabled = agent?.state.enabled ?? false
  const meta =
    tab === 'serial'
      ? `115200 8N1${isRunning ? ' · live' : ''}`
      : tab === 'console'
        ? `${buildLog.length} line${buildLog.length === 1 ? '' : 's'}${buildRunning ? ' · building' : ''}`
        : tab === 'actions'
          ? `${firmwareActions.length} required change${firmwareActions.length === 1 ? '' : 's'}`
          : tab === 'agent'
            ? agent
              ? agent.state.busy
                ? 'running'
                : agent.state.ready
                  ? 'idle'
                  : 'connecting…'
              : ''
            : `${diagnostics.length} message${diagnostics.length === 1 ? '' : 's'}`

  return (
    <section
      className="dock"
      style={{ height: collapsed ? undefined : height }}
      data-collapsed={collapsed || undefined}
      aria-label="Dock"
    >
      {!collapsed && (
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
      )}
      <div className="dock__tabs" role="tablist" aria-label="Dock panels">
        <button
          type="button"
          className="dock__chevron"
          aria-label={collapsed ? 'Expand dock' : 'Collapse dock'}
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          {collapsed ? '▴' : '▾'}
        </button>
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
          aria-selected={tab === 'compiler'}
          data-active={tab === 'compiler' || undefined}
          onClick={() => onSelectTab('compiler')}
        >
          Compiler output
          {diagnostics.length > 0 && <span className="tab__badge">{diagnostics.length}</span>}
        </button>
        <button
          type="button"
          role="tab"
          className="tab"
          aria-selected={tab === 'console'}
          data-active={tab === 'console' || undefined}
          onClick={() => onSelectTab('console')}
        >
          Console output
        </button>
        <button
          type="button"
          role="tab"
          className="tab"
          aria-selected={tab === 'actions'}
          data-active={tab === 'actions' || undefined}
          onClick={() => onSelectTab('actions')}
        >
          Firmware actions
          {firmwareActions.length > 0 && (
            <span className="tab__badge">{firmwareActions.length}</span>
          )}
        </button>
        {agentEnabled && (
          <button
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === 'agent'}
            data-active={tab === 'agent' || undefined}
            onClick={() => onSelectTab('agent')}
          >
            Agent
            {agent?.permission && <span className="tab__badge">!</span>}
          </button>
        )}
        <span className="dock__meta">{meta}</span>
        <span className="dock__tabs-spacer" />
        <button type="button" className="dock__close" aria-label="Hide dock" onClick={onClose}>
          ×
        </button>
      </div>

      {collapsed ? null : tab === 'serial' ? (
        <div className="dock__body dock__body--serial" role="tabpanel" aria-label="Serial monitor">
          <ol className="serial" ref={listRef} onScroll={onScroll}>
            {serial.map((line, index) => (
              <li className="serial__line" key={`${line.t}-${index}`}>
                <span className="serial__stamp">{stamp(line.t)}</span>
                <span className="serial__text">{line.text}</span>
              </li>
            ))}
            <li ref={serialEndRef} className="serial__anchor" aria-hidden="true" />
          </ol>
          <form className="serial__input" onSubmit={handleSerialSubmit} aria-label="Serial input">
            <span className="serial__prompt">›</span>
            <input
              type="text"
              disabled={!isRunning}
              placeholder={isRunning ? 'Type a command…' : 'Serial input needs a running emulator'}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              aria-label="Send to firmware"
            />
          </form>
        </div>
      ) : tab === 'console' ? (
        <div className="dock__body dock__body--console" role="tabpanel" aria-label="Console output">
          {showBuildLog ? (
            <ol className="buildlog" aria-label="Build output">
              {buildLog.map((line, index) => (
                <li className="buildlog__line" data-stream={line.stream} key={index}>
                  {line.text || ' '}
                </li>
              ))}
              <li ref={buildEndRef} className="serial__anchor" aria-hidden="true" />
            </ol>
          ) : (
            <p className="dock__empty">No build output yet — run Build &amp; flash.</p>
          )}
        </div>
      ) : tab === 'actions' ? (
        <div
          className="dock__body dock__body--diagnostics"
          role="tabpanel"
          aria-label="Firmware actions"
        >
          {firmwareActions.length === 0 && (
            <p className="dock__empty">
              The firmware matches this hardware profile. Changes it needs show up here, in the
              project&apos;s .pinbench/actions.md, and in the firmware_actions MCP tool.
            </p>
          )}
          <ul className="diagnostics">
            {firmwareActions.map((action) => {
              const clickable = action.file !== undefined
              const Row = clickable ? 'button' : 'div'
              return (
                <li className="diagnostic" key={action.id}>
                  <Row
                    type={clickable ? 'button' : undefined}
                    className="diagnostic__row"
                    data-clickable={clickable || undefined}
                    title={action.fix}
                    onClick={
                      clickable
                        ? () => onOpenInEditor(action.file!, action.line, action.column)
                        : undefined
                    }
                  >
                    <span className="diagnostic__severity" data-severity={action.severity}>
                      {action.severity}
                    </span>
                    <span className="diagnostic__message">{action.message}</span>
                    {action.file !== undefined && (
                      <span className="diagnostic__source">
                        {action.file}
                        {action.line !== undefined && `:${action.line}`}
                      </span>
                    )}
                  </Row>
                </li>
              )
            })}
          </ul>
        </div>
      ) : tab === 'agent' ? (
        agent ? (
          <AgentPanel
            state={agent.state}
            turn={agent.turn}
            permission={agent.permission}
            error={agent.error}
            onPrompt={agent.prompt}
            onCancel={agent.cancel}
            onSetAutoApprove={agent.setAutoApprove}
            onResolvePermission={agent.resolvePermission}
          />
        ) : (
          <div className="dock__body" role="tabpanel" aria-label="Agent">
            <p className="dock__empty">The agent control plane is not available.</p>
          </div>
        )
      ) : (
        <div
          className="dock__body dock__body--diagnostics"
          role="tabpanel"
          aria-label="Compiler output"
        >
          {diagnostics.length === 0 && (
            <p className="dock__empty">
              {buildRunning ? 'Build running — see Console output.' : 'No compiler messages.'}
            </p>
          )}
          <ul className="diagnostics">
            {diagnostics.map((row) => {
              const clickable = row.file !== undefined
              const Row = clickable ? 'button' : 'div'
              return (
                <li className="diagnostic" key={row.id}>
                  <Row
                    type={clickable ? 'button' : undefined}
                    className="diagnostic__row"
                    data-clickable={clickable || undefined}
                    onClick={
                      clickable ? () => onOpenInEditor(row.file!, row.line, row.column) : undefined
                    }
                  >
                    <span className="diagnostic__severity" data-severity={row.severity}>
                      {row.severity}
                    </span>
                    <span className="diagnostic__message">{row.message}</span>
                    {row.file !== undefined && (
                      <span className="diagnostic__source">
                        {shortPath(row.file)}
                        {row.line !== undefined && `:${row.line}`}
                      </span>
                    )}
                  </Row>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}
