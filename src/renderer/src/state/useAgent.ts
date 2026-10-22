import { useCallback, useEffect, useState } from 'react'
import { applySessionUpdate, emptyTurn, type AgentTurn } from '@shared/acp/sessionUpdate'
import type { AgentBridgeState, AgentPermissionDecision, AgentPermissionRequest } from '@shared/ipc'

const OFFLINE_STATE: AgentBridgeState = {
  enabled: false,
  agentConfigured: false,
  ready: false,
  busy: false,
  autoApprove: false
}

export interface AgentHandle {
  state: AgentBridgeState
  /** The reduced view of the running / last turn. */
  turn: AgentTurn
  /** The approval the bridge is currently waiting on, if any. */
  permission: AgentPermissionRequest | null
  /** Last prompt error surfaced by the bridge, cleared on the next prompt. */
  error: string | null
  prompt(text: string): void
  cancel(): void
  setAutoApprove(on: boolean): void
  resolvePermission(decision: AgentPermissionDecision, optionId?: string): void
}

/**
 * Drives the dock's Agent panel: pushes `agent:panel-present` so the main
 * process routes permission prompts inline, replays the buffered turn on mount,
 * folds each `session/update` through the shared reducer, and exposes the
 * prompt / cancel / policy / approve actions.
 */
export function useAgent(): AgentHandle {
  const [state, setState] = useState<AgentBridgeState>(OFFLINE_STATE)
  const [turn, setTurn] = useState<AgentTurn>(emptyTurn)
  const [permission, setPermission] = useState<AgentPermissionRequest | null>(null)
  const [error, setError] = useState<string | null>(null)

  const applyUpdate = useCallback((params: unknown) => {
    setTurn((prev) => applySessionUpdate(prev, params))
  }, [])

  useEffect(() => {
    window.pinbench.agent.setPanelPresent(true)
    void window.pinbench.agent.state().then(setState)
    void window.pinbench.agent.backlog().then((updates) => {
      setTurn(updates.reduce<AgentTurn>((acc, u) => applySessionUpdate(acc, u), emptyTurn()))
    })
    const offState = window.pinbench.agent.onState(setState)
    const offUpdate = window.pinbench.agent.onUpdate(applyUpdate)
    const offPermission = window.pinbench.agent.onPermissionRequest(setPermission)
    return () => {
      window.pinbench.agent.setPanelPresent(false)
      offState()
      offUpdate()
      offPermission()
    }
  }, [applyUpdate])

  const prompt = useCallback((text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    setError(null)
    // Start a fresh turn, seeded with what the user asked.
    setTurn(
      applySessionUpdate(emptyTurn(), {
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: trimmed } }
      })
    )
    void window.pinbench.agent.prompt(trimmed).then((result) => {
      if (result && typeof result === 'object' && 'error' in result) {
        setError((result as { error: string }).error)
      }
    })
  }, [])

  const cancel = useCallback(() => window.pinbench.agent.cancel(), [])

  const setAutoApprove = useCallback((on: boolean) => window.pinbench.agent.setAutoApprove(on), [])

  const resolvePermission = useCallback((decision: AgentPermissionDecision, optionId?: string) => {
    setPermission((current) => {
      if (current) window.pinbench.agent.resolvePermission(current.id, decision, optionId)
      return null
    })
  }, [])

  return { state, turn, permission, error, prompt, cancel, setAutoApprove, resolvePermission }
}
