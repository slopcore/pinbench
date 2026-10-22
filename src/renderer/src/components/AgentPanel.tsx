import { useEffect, useRef, useState } from 'react'
import type { AgentTurn, ToolCallStatus, TurnEntry } from '@shared/acp/sessionUpdate'
import type { AgentBridgeState, AgentPermissionDecision, AgentPermissionRequest } from '@shared/ipc'
import './agent-panel.css'

export interface AgentPanelProps {
  state: AgentBridgeState
  turn: AgentTurn
  permission: AgentPermissionRequest | null
  error: string | null
  onPrompt: (text: string) => void
  onCancel: () => void
  onSetAutoApprove: (on: boolean) => void
  onResolvePermission: (decision: AgentPermissionDecision, optionId?: string) => void
}

const STATUS_GLYPH: Record<ToolCallStatus, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
  failed: '✕'
}

/**
 * The dock's Agent tab (roadmap M16.4): the running ACP turn — assistant text,
 * thoughts, tool-call cards, the plan — plus a prompt box, a stop button, the
 * auto-approve policy toggle, and any inline permission prompt the bridge is
 * blocked on. Purely presentational; {@link useAgent} owns the wiring.
 */
export function AgentPanel({
  state,
  turn,
  permission,
  error,
  onPrompt,
  onCancel,
  onSetAutoApprove,
  onResolvePermission
}: AgentPanelProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [turn, permission])

  if (!state.enabled) {
    return (
      <div className="dock__body agentpanel" role="tabpanel" aria-label="Agent">
        <p className="dock__empty">
          The agent control plane is off. Start PinBench with <code>--acp</code> (or{' '}
          <code>PINBENCH_ACP=1</code>) to enable it.
        </p>
      </div>
    )
  }

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!draft.trim() || state.busy || !state.ready) return
    onPrompt(draft)
    setDraft('')
  }

  const statusLabel = !state.agentConfigured
    ? 'no agent — set PINBENCH_AGENT_CMD'
    : !state.ready
      ? 'connecting…'
      : state.busy
        ? 'running'
        : 'idle'

  return (
    <div className="dock__body agentpanel" role="tabpanel" aria-label="Agent">
      <div className="agentpanel__bar">
        <span className="agentpanel__status" data-state={state.busy ? 'busy' : 'idle'}>
          {statusLabel}
        </span>
        <label className="agentpanel__policy">
          <input
            type="checkbox"
            checked={state.autoApprove}
            onChange={(e) => onSetAutoApprove(e.target.checked)}
          />
          Auto-approve actions
        </label>
        <span className="agentpanel__bar-spacer" />
        {state.busy && (
          <button type="button" className="agentpanel__stop" onClick={onCancel}>
            Stop
          </button>
        )}
      </div>

      <div className="agentpanel__scroll">
        {turn.entries.length === 0 && !turn.plan && (
          <p className="dock__empty">
            {state.ready ? 'Ask the agent to do something.' : 'Waiting for the agent to connect…'}
          </p>
        )}

        {turn.plan && turn.plan.length > 0 && (
          <ol className="agentpanel__plan" aria-label="Plan">
            {turn.plan.map((step, i) => (
              <li key={i} data-status={step.status}>
                {step.content}
              </li>
            ))}
          </ol>
        )}

        <ul className="agentpanel__entries">
          {turn.entries.map((entry, i) => (
            <EntryRow key={i} entry={entry} />
          ))}
        </ul>

        {error && <p className="agentpanel__error">{error}</p>}

        {permission && (
          <div
            className="agentpanel__perm"
            role="alertdialog"
            aria-label="Agent permission request"
          >
            <p className="agentpanel__perm-title">
              {permission.kind === 'exec' ? 'Agent action' : 'Agent tool call'}: {permission.title}
            </p>
            {permission.detail && (
              <pre className="agentpanel__perm-detail">{permission.detail}</pre>
            )}
            <div className="agentpanel__perm-actions">
              {permission.options?.map((opt) => (
                <button
                  key={opt.optionId}
                  type="button"
                  onClick={() => onResolvePermission('once', opt.optionId)}
                >
                  {opt.name}
                </button>
              ))}
              {!permission.options && (
                <button type="button" onClick={() => onResolvePermission('once')}>
                  Allow once
                </button>
              )}
              <button type="button" onClick={() => onResolvePermission('session')}>
                Allow for session
              </button>
              <button type="button" onClick={() => onResolvePermission('always')}>
                Always allow
              </button>
              <button
                type="button"
                className="agentpanel__perm-deny"
                onClick={() => onResolvePermission('deny')}
              >
                Deny
              </button>
            </div>
          </div>
        )}

        <div ref={endRef} aria-hidden="true" />
      </div>

      <form className="agentpanel__input" onSubmit={submit} aria-label="Agent prompt">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!state.ready || state.busy}
          placeholder={
            !state.agentConfigured
              ? 'Set PINBENCH_AGENT_CMD to run an agent'
              : !state.ready
                ? 'Agent connecting…'
                : state.busy
                  ? 'Agent is working…'
                  : 'Ask the agent…'
          }
          aria-label="Prompt the agent"
        />
        <button type="submit" disabled={!state.ready || state.busy || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}

function EntryRow({ entry }: { entry: TurnEntry }): React.JSX.Element {
  if (entry.kind === 'message') {
    return (
      <li className="agentpanel__msg" data-role={entry.role}>
        {entry.text}
      </li>
    )
  }
  if (entry.kind === 'thought') {
    return <li className="agentpanel__thought">{entry.text}</li>
  }
  return (
    <li className="agentpanel__tool" data-status={entry.status}>
      <div className="agentpanel__tool-head">
        <span className="agentpanel__tool-glyph">{STATUS_GLYPH[entry.status]}</span>
        <span className="agentpanel__tool-title">{entry.title}</span>
        <span className="agentpanel__tool-status">{entry.status.replace('_', ' ')}</span>
      </div>
      {entry.output && <pre className="agentpanel__tool-output">{entry.output}</pre>}
    </li>
  )
}
