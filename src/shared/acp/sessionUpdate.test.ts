import { describe, expect, it } from 'vitest'
import {
  applySessionUpdate,
  contentText,
  emptyTurn,
  parseSessionUpdate,
  reduceTurn,
  type AgentTurn,
  type ToolCallEntry
} from './sessionUpdate'

/** Wrap an `update` object the way ACP's `session/update` params nest it. */
const note = (update: Record<string, unknown>): { sessionId: string; update: unknown } => ({
  sessionId: 's1',
  update
})

const textChunk = (kind: string, text: string): Record<string, unknown> => ({
  sessionUpdate: kind,
  content: { type: 'text', text }
})

const feed = (updates: Array<Record<string, unknown>>): AgentTurn =>
  updates.reduce<AgentTurn>((turn, u) => applySessionUpdate(turn, note(u)), emptyTurn())

describe('parseSessionUpdate', () => {
  it('reads the nested update object', () => {
    expect(parseSessionUpdate(note(textChunk('agent_message_chunk', 'hi')))).toEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hi' }
    })
  })

  it('tolerates a flattened payload', () => {
    expect(parseSessionUpdate(textChunk('agent_thought_chunk', 'hmm'))).toMatchObject({
      sessionUpdate: 'agent_thought_chunk'
    })
  })

  it('returns null for an unknown kind', () => {
    expect(parseSessionUpdate(note({ sessionUpdate: 'made_up' }))).toBeNull()
  })

  it('drops a tool_call with no id', () => {
    expect(parseSessionUpdate(note({ sessionUpdate: 'tool_call', title: 'x' }))).toBeNull()
  })

  it('drops an out-of-range tool status', () => {
    const parsed = parseSessionUpdate(
      note({ sessionUpdate: 'tool_call', toolCallId: 't1', status: 'bogus' })
    )
    expect(parsed).toMatchObject({ toolCallId: 't1' })
    expect(parsed && 'status' in parsed).toBe(false)
  })
})

describe('contentText', () => {
  it('returns text for a text block', () => {
    expect(contentText({ type: 'text', text: 'abc' })).toBe('abc')
  })
  it('labels a non-text block', () => {
    expect(contentText({ type: 'image', data: 'x' })).toBe('[image]')
  })
  it('is empty for undefined', () => {
    expect(contentText(undefined)).toBe('')
  })
})

describe('reduceTurn — message chunks', () => {
  it('coalesces consecutive assistant chunks into one bubble', () => {
    const turn = feed([
      textChunk('agent_message_chunk', 'Hel'),
      textChunk('agent_message_chunk', 'lo '),
      textChunk('agent_message_chunk', 'world')
    ])
    expect(turn.entries).toEqual([{ kind: 'message', role: 'assistant', text: 'Hello world' }])
  })

  it('starts a new bubble when the role changes', () => {
    const turn = feed([
      textChunk('agent_message_chunk', 'a'),
      textChunk('user_message_chunk', 'b'),
      textChunk('agent_message_chunk', 'c')
    ])
    expect(turn.entries.map((e) => (e.kind === 'message' ? e.role : e.kind))).toEqual([
      'assistant',
      'user',
      'assistant'
    ])
  })

  it('keeps thoughts separate from messages', () => {
    const turn = feed([
      textChunk('agent_thought_chunk', 'thinking'),
      textChunk('agent_message_chunk', 'answer')
    ])
    expect(turn.entries).toEqual([
      { kind: 'thought', text: 'thinking' },
      { kind: 'message', role: 'assistant', text: 'answer' }
    ])
  })
})

describe('reduceTurn — tool calls merge by id', () => {
  it('folds tool_call + N updates into a single card', () => {
    const turn = feed([
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'build_start', status: 'pending' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'done' } }]
      }
    ])
    const calls = turn.entries.filter((e): e is ToolCallEntry => e.kind === 'tool_call')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      id: 'c1',
      title: 'build_start',
      status: 'completed',
      output: 'done'
    })
  })

  it('accumulates streamed output across updates', () => {
    const turn = feed([
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 't' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        content: [{ type: 'content', content: { type: 'text', text: 'line 1\n' } }]
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        content: [{ type: 'content', content: { type: 'text', text: 'line 2\n' } }]
      }
    ])
    const call = turn.entries.find((e): e is ToolCallEntry => e.kind === 'tool_call')
    expect(call?.output).toBe('line 1\nline 2\n')
  })

  it('keeps two distinct tool calls apart', () => {
    const turn = feed([
      { sessionUpdate: 'tool_call', toolCallId: 'a', title: 'first' },
      { sessionUpdate: 'tool_call', toolCallId: 'b', title: 'second' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed' }
    ])
    const calls = turn.entries.filter((e): e is ToolCallEntry => e.kind === 'tool_call')
    expect(calls.map((c) => [c.id, c.status])).toEqual([
      ['a', 'completed'],
      ['b', 'pending']
    ])
  })

  it('creates a card if the first sight of a call is an update', () => {
    const turn = feed([{ sessionUpdate: 'tool_call_update', toolCallId: 'z', status: 'completed' }])
    expect(turn.entries).toEqual([
      { kind: 'tool_call', id: 'z', title: 'z', status: 'completed', output: '' }
    ])
  })

  it('preserves interleaved message / tool ordering', () => {
    const turn = feed([
      textChunk('agent_message_chunk', 'let me build'),
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'build_start' },
      textChunk('agent_message_chunk', 'now booting')
    ])
    expect(turn.entries.map((e) => e.kind)).toEqual(['message', 'tool_call', 'message'])
  })
})

describe('reduceTurn — plan and metadata', () => {
  it('replaces the plan wholesale and defaults fields', () => {
    const turn = feed([
      { sessionUpdate: 'plan', entries: [{ content: 'step 1' }] },
      {
        sessionUpdate: 'plan',
        entries: [
          { content: 'step 1', status: 'completed', priority: 'high' },
          { content: 'step 2', status: 'in_progress' }
        ]
      }
    ])
    expect(turn.plan).toEqual([
      { content: 'step 1', status: 'completed', priority: 'high' },
      { content: 'step 2', status: 'in_progress', priority: 'medium' }
    ])
  })

  it('tracks available commands and the current mode', () => {
    const turn = feed([
      { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'test' }] },
      { sessionUpdate: 'current_mode_update', currentModeId: 'ask' }
    ])
    expect(turn.availableCommands).toEqual([{ name: 'test' }])
    expect(turn.currentModeId).toBe('ask')
  })
})

describe('reduceTurn — purity', () => {
  it('never mutates the input turn', () => {
    const start = emptyTurn()
    const next = reduceTurn(start, parseSessionUpdate(note(textChunk('agent_message_chunk', 'x'))))
    expect(start.entries).toEqual([])
    expect(next).not.toBe(start)
  })

  it('is a no-op for an unparseable update', () => {
    const start = feed([textChunk('agent_message_chunk', 'x')])
    expect(reduceTurn(start, null)).toBe(start)
  })
})
