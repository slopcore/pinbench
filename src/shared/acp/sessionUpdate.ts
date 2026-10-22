/**
 * The `session/update` stream, reduced to something a panel can render
 * (roadmap M16.4).
 *
 * ACP streams a turn as a sequence of `session/update` notifications, each an
 * `update` object discriminated by `sessionUpdate`:
 *
 *  - `user_message_chunk` / `agent_message_chunk` / `agent_thought_chunk` —
 *    a {@link ContentBlock}, streamed a token at a time;
 *  - `tool_call` — a tool invocation appears (`toolCallId`, `title`, `status`);
 *  - `tool_call_update` — the same `toolCallId` progresses
 *    (`pending → in_progress → completed | failed`), often carrying more
 *    content;
 *  - `plan` — the agent's current step list;
 *  - `available_commands_update` / `current_mode_update` — session metadata.
 *
 * {@link reduceTurn} folds that stream into an {@link AgentTurn}. The critical
 * rule: tool calls are **merged by `toolCallId`**, never appended — three
 * updates for one call render one card, not three. The reducer is pure and
 * Electron-free so it is unit-tested against a scripted update sequence; the
 * renderer only draws the reduced value.
 *
 * Shapes validated against `@zed-industries/agent-client-protocol@0.4.5`
 * (`schema.ts` `SessionNotification` / `SessionUpdate`). PinBench keeps its own
 * copy so `shared/` stays dependency-free.
 */

// ── Wire shapes ────────────────────────────────────────────────────────────

/** An ACP content block. Only text is rendered; other kinds keep a label. */
export interface ContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

/** One entry of a tool call's streamed content. */
export interface ToolCallContent {
  type: string
  content?: ContentBlock
  [key: string]: unknown
}

export interface ToolCallFields {
  toolCallId: string
  title?: string
  kind?: string
  status?: ToolCallStatus
  content?: ToolCallContent[]
  rawInput?: unknown
  rawOutput?: unknown
}

export interface PlanEntryWire {
  content: string
  priority?: 'high' | 'medium' | 'low'
  status?: 'pending' | 'in_progress' | 'completed'
}

export interface AvailableCommandWire {
  name: string
  description?: string
}

export type SessionUpdate =
  | { sessionUpdate: 'user_message_chunk'; content: ContentBlock }
  | { sessionUpdate: 'agent_message_chunk'; content: ContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content: ContentBlock }
  | ({ sessionUpdate: 'tool_call' } & ToolCallFields)
  | ({ sessionUpdate: 'tool_call_update' } & ToolCallFields)
  | { sessionUpdate: 'plan'; entries: PlanEntryWire[] }
  | { sessionUpdate: 'available_commands_update'; availableCommands: AvailableCommandWire[] }
  | { sessionUpdate: 'current_mode_update'; currentModeId: string }

// ── Reduced model ─────────────────────────────────────────────────────────

export interface MessageEntry {
  kind: 'message'
  role: 'assistant' | 'user'
  text: string
}

export interface ThoughtEntry {
  kind: 'thought'
  text: string
}

export interface ToolCallEntry {
  kind: 'tool_call'
  id: string
  title: string
  toolKind?: string
  status: ToolCallStatus
  /** Concatenated text output the call has streamed so far. */
  output: string
}

export type TurnEntry = MessageEntry | ThoughtEntry | ToolCallEntry

export interface PlanEntry {
  content: string
  priority: 'high' | 'medium' | 'low'
  status: 'pending' | 'in_progress' | 'completed'
}

export interface AgentTurn {
  /** In arrival order; tool calls merged in place by id. */
  entries: TurnEntry[]
  plan: PlanEntry[] | null
  availableCommands: AvailableCommandWire[] | null
  currentModeId: string | null
}

export function emptyTurn(): AgentTurn {
  return { entries: [], plan: null, availableCommands: null, currentModeId: null }
}

// ── Parsing ───────────────────────────────────────────────────────────────

const CHUNK_KINDS = new Set(['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk'])
const TOOL_KINDS = new Set(['tool_call', 'tool_call_update'])
const TOOL_STATUSES = new Set<ToolCallStatus>(['pending', 'in_progress', 'completed', 'failed'])

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/**
 * Pull the `update` object out of a raw `session/update` params payload and
 * validate it enough to reduce. Returns `null` for anything unrecognised
 * (an unknown `sessionUpdate` kind, a missing `toolCallId`, …) so the reducer
 * can ignore it rather than throw on a stream it does not model.
 */
export function parseSessionUpdate(params: unknown): SessionUpdate | null {
  const outer = asRecord(params)
  if (!outer) return null
  // ACP nests the payload under `update`; tolerate a flattened form too.
  const raw = asRecord(outer['update']) ?? outer
  const kind = raw['sessionUpdate']
  if (typeof kind !== 'string') return null

  if (CHUNK_KINDS.has(kind)) {
    const content = asRecord(raw['content'])
    if (!content || typeof content['type'] !== 'string') return null
    return { sessionUpdate: kind as 'agent_message_chunk', content: content as ContentBlock }
  }

  if (TOOL_KINDS.has(kind)) {
    const toolCallId = raw['toolCallId']
    if (typeof toolCallId !== 'string' || toolCallId === '') return null
    const status = raw['status']
    const content = Array.isArray(raw['content'])
      ? (raw['content'] as ToolCallContent[])
      : undefined
    return {
      sessionUpdate: kind as 'tool_call',
      toolCallId,
      ...(typeof raw['title'] === 'string' ? { title: raw['title'] } : {}),
      ...(typeof raw['kind'] === 'string' ? { kind: raw['kind'] } : {}),
      ...(typeof status === 'string' && TOOL_STATUSES.has(status as ToolCallStatus)
        ? { status: status as ToolCallStatus }
        : {}),
      ...(content ? { content } : {})
    }
  }

  if (kind === 'plan') {
    const entries = Array.isArray(raw['entries']) ? (raw['entries'] as PlanEntryWire[]) : []
    return { sessionUpdate: 'plan', entries }
  }

  if (kind === 'available_commands_update') {
    const list = Array.isArray(raw['availableCommands'])
      ? (raw['availableCommands'] as AvailableCommandWire[])
      : []
    return { sessionUpdate: 'available_commands_update', availableCommands: list }
  }

  if (kind === 'current_mode_update') {
    const id = raw['currentModeId']
    if (typeof id !== 'string') return null
    return { sessionUpdate: 'current_mode_update', currentModeId: id }
  }

  return null
}

// ── Reduction ─────────────────────────────────────────────────────────────

/** Text carried by a content block, or a bracketed label for a non-text kind. */
export function contentText(block: ContentBlock | undefined): string {
  if (!block) return ''
  if (block.type === 'text') return typeof block.text === 'string' ? block.text : ''
  if (typeof block.text === 'string') return block.text
  return `[${block.type}]`
}

function toolContentText(entries: ToolCallContent[] | undefined): string {
  if (!entries) return ''
  const parts: string[] = []
  for (const entry of entries) {
    if (entry.type === 'content') {
      parts.push(contentText(entry.content))
    } else if (entry.type === 'diff') {
      parts.push('[diff]')
    } else {
      parts.push(`[${entry.type}]`)
    }
  }
  return parts.join('')
}

function normalisePlan(entries: PlanEntryWire[]): PlanEntry[] {
  return entries.map((entry) => ({
    content: entry.content,
    priority: entry.priority ?? 'medium',
    status: entry.status ?? 'pending'
  }))
}

/**
 * Fold one parsed update into the turn, returning a new {@link AgentTurn}
 * (the input is never mutated). Unknown updates return the turn unchanged —
 * pass the result of {@link parseSessionUpdate}; `null` is a no-op.
 */
export function reduceTurn(turn: AgentTurn, update: SessionUpdate | null): AgentTurn {
  if (!update) return turn

  switch (update.sessionUpdate) {
    case 'user_message_chunk':
    case 'agent_message_chunk': {
      const role = update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant'
      return appendChunk(turn, { kind: 'message', role, text: contentText(update.content) })
    }

    case 'agent_thought_chunk':
      return appendChunk(turn, { kind: 'thought', text: contentText(update.content) })

    case 'tool_call':
    case 'tool_call_update':
      return mergeToolCall(turn, update)

    case 'plan':
      return { ...turn, plan: normalisePlan(update.entries) }

    case 'available_commands_update':
      return { ...turn, availableCommands: update.availableCommands }

    case 'current_mode_update':
      return { ...turn, currentModeId: update.currentModeId }
  }
}

/**
 * Streamed chunks of the same kind coalesce into the trailing entry; anything
 * else (a tool call, a different role) breaks the run into a new bubble.
 */
function appendChunk(turn: AgentTurn, chunk: MessageEntry | ThoughtEntry): AgentTurn {
  const last = turn.entries[turn.entries.length - 1]
  const sameRun =
    last &&
    last.kind === chunk.kind &&
    (chunk.kind !== 'message' || (last as MessageEntry).role === chunk.role)
  if (sameRun) {
    const merged: TurnEntry = { ...last, text: last.text + chunk.text } as TurnEntry
    return { ...turn, entries: [...turn.entries.slice(0, -1), merged] }
  }
  return { ...turn, entries: [...turn.entries, chunk] }
}

function mergeToolCall(
  turn: AgentTurn,
  update: Extract<SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>
): AgentTurn {
  const index = turn.entries.findIndex(
    (entry) => entry.kind === 'tool_call' && entry.id === update.toolCallId
  )
  const chunkText = toolContentText(update.content)

  if (index === -1) {
    const entry: ToolCallEntry = {
      kind: 'tool_call',
      id: update.toolCallId,
      title: update.title ?? update.toolCallId,
      ...(update.kind ? { toolKind: update.kind } : {}),
      status: update.status ?? 'pending',
      output: chunkText
    }
    return { ...turn, entries: [...turn.entries, entry] }
  }

  const existing = turn.entries[index] as ToolCallEntry
  const merged: ToolCallEntry = {
    ...existing,
    ...(update.title ? { title: update.title } : {}),
    ...(update.kind ? { toolKind: update.kind } : {}),
    ...(update.status ? { status: update.status } : {}),
    output: existing.output + chunkText
  }
  const entries = [...turn.entries]
  entries[index] = merged
  return { ...turn, entries }
}

/** Convenience: parse a raw `session/update` payload and fold it in one call. */
export function applySessionUpdate(turn: AgentTurn, params: unknown): AgentTurn {
  return reduceTurn(turn, parseSessionUpdate(params))
}
