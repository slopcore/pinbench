/**
 * A JSON-RPC 2.0 peer over a newline-delimited byte stream (roadmap M16.3).
 *
 * Both sides of ACP are symmetric — each end sends requests and serves them —
 * so this one class drives the agent connection: {@link request} / {@link
 * notify} go out, an injected handler map answers what comes in. Transport is
 * a `{ read, write }` pair, so a child process's stdio in production and a
 * pipe in tests.
 */

import type { RpcHandler } from '../../shared/acp/dispatch'
import { Dispatcher } from '../../shared/acp/dispatch'
import {
  NdjsonBuffer,
  encodeFrame,
  isResponse,
  parseFrame,
  request as makeRequest,
  notification as makeNotification,
  type JsonRpcId,
  type JsonRpcResponse
} from '../../shared/acp/jsonrpc'

export interface LineTransport {
  /** Called with each decoded chunk of incoming bytes. */
  onData(listener: (chunk: string) => void): void
  /** Called once the far end closes. */
  onClose(listener: () => void): void
  write(frame: string): void
  close(): void
}

interface Pending {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

export class AcpConnectionError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'AcpConnectionError'
  }
}

export class AcpConnection {
  private readonly buffer = new NdjsonBuffer()
  private readonly dispatcher: Dispatcher
  private readonly pending = new Map<JsonRpcId, Pending>()
  private nextId = 1
  private closed = false

  constructor(
    private readonly transport: LineTransport,
    handlers: Record<string, RpcHandler> = {}
  ) {
    this.dispatcher = new Dispatcher(handlers)
    transport.onData((chunk) => {
      for (const line of this.buffer.push(chunk)) void this.receive(line)
    })
    transport.onClose(() => this.onClosed())
  }

  /** Register or replace an inbound handler. */
  on(method: string, handler: RpcHandler): this {
    this.dispatcher.on(method, handler)
    return this
  }

  /** Send a request and resolve with its result, or reject with the error. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new AcpConnectionError('connection closed'))
    const id = this.nextId++
    const frame = encodeFrame(makeRequest(id, method, params))
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (r) => resolve(r as T), reject })
      this.transport.write(frame)
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return
    this.transport.write(encodeFrame(makeNotification(method, params)))
  }

  close(): void {
    if (this.closed) return
    this.transport.close()
    this.onClosed()
  }

  private onClosed(): void {
    if (this.closed) return
    this.closed = true
    for (const { reject } of this.pending.values()) {
      reject(new AcpConnectionError('connection closed before reply'))
    }
    this.pending.clear()
  }

  private async receive(line: string): Promise<void> {
    const parsed = parseFrame(line)
    if (!parsed.ok) return // a malformed frame from the agent is dropped, not fatal
    const message = parsed.message

    if (isResponse(message)) {
      this.settle(message)
      return
    }

    const response = await this.dispatcher.handle(message)
    if (response) this.transport.write(encodeFrame(response))
  }

  private settle(message: JsonRpcResponse): void {
    if (message.id === null) return
    const waiter = this.pending.get(message.id)
    if (!waiter) return
    this.pending.delete(message.id)
    if ('result' in message) waiter.resolve(message.result)
    else
      waiter.reject(
        new AcpConnectionError(message.error.message, message.error.code, message.error.data)
      )
  }
}
