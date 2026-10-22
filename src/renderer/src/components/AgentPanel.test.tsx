import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { emptyTurn, applySessionUpdate } from '@shared/acp/sessionUpdate'
import type { AgentBridgeState } from '@shared/ipc'
import { AgentPanel, type AgentPanelProps } from './AgentPanel'

const state = (over: Partial<AgentBridgeState> = {}): AgentBridgeState => ({
  enabled: true,
  agentConfigured: true,
  ready: true,
  busy: false,
  autoApprove: false,
  ...over
})

const props = (over: Partial<AgentPanelProps> = {}): AgentPanelProps => ({
  state: state(),
  turn: emptyTurn(),
  permission: null,
  error: null,
  onPrompt: vi.fn(),
  onCancel: vi.fn(),
  onSetAutoApprove: vi.fn(),
  onResolvePermission: vi.fn(),
  ...over
})

const feed = (updates: Array<Record<string, unknown>>) =>
  updates.reduce((t, u) => applySessionUpdate(t, { update: u }), emptyTurn())

describe('AgentPanel', () => {
  it('explains itself when the bridge is disabled', () => {
    render(<AgentPanel {...props({ state: state({ enabled: false }) })} />)
    expect(screen.getByText(/--acp/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Prompt the agent')).not.toBeInTheDocument()
  })

  it('disables the prompt until the agent is ready', () => {
    render(<AgentPanel {...props({ state: state({ ready: false }) })} />)
    expect(screen.getByLabelText('Prompt the agent')).toBeDisabled()
  })

  it('sends a prompt and clears the box', async () => {
    const onPrompt = vi.fn()
    const user = userEvent.setup()
    render(<AgentPanel {...props({ onPrompt })} />)
    const box = screen.getByLabelText('Prompt the agent')
    await user.type(box, 'boot the emulator')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(onPrompt).toHaveBeenCalledWith('boot the emulator')
    expect(box).toHaveValue('')
  })

  it('renders one card per tool call, not one per update', () => {
    const turn = feed([
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'build_start', status: 'pending' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' }
    ])
    render(<AgentPanel {...props({ turn })} />)
    expect(screen.getAllByText('build_start')).toHaveLength(1)
    expect(screen.getByText('completed')).toBeInTheDocument()
  })

  it('shows a Stop button only while busy and wires it to onCancel', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(<AgentPanel {...props({ onCancel })} />)
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
    rerender(<AgentPanel {...props({ onCancel, state: state({ busy: true }) })} />)
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('toggles the auto-approve policy', async () => {
    const onSetAutoApprove = vi.fn()
    const user = userEvent.setup()
    render(<AgentPanel {...props({ onSetAutoApprove })} />)
    await user.click(screen.getByLabelText('Auto-approve actions'))
    expect(onSetAutoApprove).toHaveBeenCalledWith(true)
  })

  it('renders an inline permission prompt and resolves each choice', async () => {
    const onResolvePermission = vi.fn()
    const user = userEvent.setup()
    render(
      <AgentPanel
        {...props({
          onResolvePermission,
          permission: {
            id: 'perm-1',
            kind: 'exec',
            title: 'Build & flash',
            detail: 'Run PlatformIO'
          }
        })}
      />
    )
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(onResolvePermission).toHaveBeenCalledWith('once')
    await user.click(screen.getByRole('button', { name: 'Deny' }))
    expect(onResolvePermission).toHaveBeenCalledWith('deny')
  })

  it('offers the agent-supplied options for a tool permission request', async () => {
    const onResolvePermission = vi.fn()
    const user = userEvent.setup()
    render(
      <AgentPanel
        {...props({
          onResolvePermission,
          permission: {
            id: 'perm-2',
            kind: 'tool',
            title: 'write file',
            options: [
              { optionId: 'allow', name: 'Yes', kind: 'allow_once' },
              { optionId: 'reject', name: 'No' }
            ]
          }
        })}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Yes' }))
    expect(onResolvePermission).toHaveBeenCalledWith('once', 'allow')
  })

  it('surfaces a prompt error', () => {
    render(<AgentPanel {...props({ error: 'no agent is running' })} />)
    expect(screen.getByText('no agent is running')).toBeInTheDocument()
  })
})
