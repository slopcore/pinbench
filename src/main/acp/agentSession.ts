/**
 * Drives one coding-agent conversation over ACP (roadmap M16.3).
 *
 * PinBench is the Client: it sends `initialize` → `session/new` (listing the
 * loopback MCP control server, so the agent's model can call PinBench's
 * operations as tools) → `session/prompt`, and serves the agent's callbacks —
 * `fs/read_text_file`, `fs/write_text_file`, `session/request_permission`, and
 * the `session/update` stream.
 *
 * The {@link AcpConnection} and the callbacks are injected, so this is
 * exercised end to end against a fake agent with no subprocess.
 */

import { ClientMethod } from '../../shared/acp/methods'
import {
  httpMcpServer,
  initializeParams,
  negotiateVersion,
  newSessionParams,
  type ClientInfo
} from '../../shared/acp/session'
import { RpcError } from '../../shared/acp/jsonrpc'
import type { AcpConnection } from './connection'

/** Serves the file-system side of the client contract, already sandboxed. */
export interface SessionFileSystem {
  readTextFile(path: string, line?: number, limit?: number): Promise<string>
  writeTextFile(path: string, content: string): Promise<void>
}

export interface SessionCallbacks {
  fs: SessionFileSystem
  /** Ask the user to approve a tool call the agent flagged. */
  requestPermission(params: unknown): Promise<{ outcome: { outcome: string; optionId?: string } }>
  /** A streamed update — assistant text, a tool call, a plan. */
  onUpdate(params: unknown): void
}

export interface AgentSessionOptions {
  connection: AcpConnection
  clientInfo: ClientInfo
  /** Working directory for the session — the open project. */
  cwd: string
  /** The loopback MCP control server the agent should connect to. */
  mcpServerUrl: string
  mcpServerToken?: string
  callbacks: SessionCallbacks
  /** Fail `start()` if the agent has not answered `initialize` + `session/new` in this long. */
  startTimeoutMs?: number
}

const DEFAULT_START_TIMEOUT_MS = 15_000

export interface PromptResult {
  stopReason: string
}

export class AgentSession {
  private readonly conn: AcpConnection
  private readonly options: AgentSessionOptions
  private sessionId: string | null = null
  private negotiatedVersion = 0

  constructor(options: AgentSessionOptions) {
    this.options = options
    this.conn = options.connection
    this.registerClientMethods()
  }

  get id(): string | null {
    return this.sessionId
  }

  /**
   * `initialize` then `session/new`; resolves once the session id is known.
   * Rejects (and does not leave a half-open session) if the agent has not
   * completed the handshake within `startTimeoutMs`.
   */
  async start(): Promise<string> {
    const timeoutMs = this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`agent did not complete the handshake in ${timeoutMs}ms`)),
        timeoutMs
      )
    })
    try {
      return await Promise.race([this.handshake(), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async handshake(): Promise<string> {
    const init = await this.conn.request<{ protocolVersion?: number }>(
      'initialize',
      initializeParams(this.options.clientInfo)
    )
    this.negotiatedVersion = negotiateVersion(init.protocolVersion)

    const server = httpMcpServer('pinbench', this.options.mcpServerUrl, this.options.mcpServerToken)
    const created = await this.conn.request<{ sessionId: string }>(
      'session/new',
      newSessionParams(this.options.cwd, server)
    )
    this.sessionId = created.sessionId
    return created.sessionId
  }

  /** Run a prompt turn to completion. */
  async prompt(text: string): Promise<PromptResult> {
    if (!this.sessionId) throw new Error('start() must resolve before prompt()')
    const result = await this.conn.request<{ stopReason?: string }>('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }]
    })
    return { stopReason: result.stopReason ?? 'end_turn' }
  }

  /** Ask the agent to abort the current turn. */
  cancel(): void {
    if (this.sessionId) this.conn.notify('session/cancel', { sessionId: this.sessionId })
  }

  get protocolVersion(): number {
    return this.negotiatedVersion
  }

  private registerClientMethods(): void {
    const { fs, requestPermission, onUpdate } = this.options.callbacks

    this.conn.on(ClientMethod.sessionUpdate, (params) => {
      onUpdate(params)
    })

    this.conn.on(ClientMethod.sessionRequestPermission, (params) => requestPermission(params))

    this.conn.on(ClientMethod.fsReadTextFile, async (params) => {
      const p = params as { path?: unknown; line?: unknown; limit?: unknown }
      if (typeof p.path !== 'string') throw RpcError.invalidParams('fs/read_text_file needs "path"')
      const content = await fs.readTextFile(
        p.path,
        typeof p.line === 'number' ? p.line : undefined,
        typeof p.limit === 'number' ? p.limit : undefined
      )
      return { content }
    })

    this.conn.on(ClientMethod.fsWriteTextFile, async (params) => {
      const p = params as { path?: unknown; content?: unknown }
      if (typeof p.path !== 'string' || typeof p.content !== 'string') {
        throw RpcError.invalidParams('fs/write_text_file needs "path" and "content"')
      }
      await fs.writeTextFile(p.path, p.content)
      return {}
    })
  }
}
