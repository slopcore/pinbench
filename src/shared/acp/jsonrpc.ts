/**
 * JSON-RPC 2.0 framing — the wire both ACP (agent ⇄ PinBench) and the MCP
 * control server (agent ⇄ PinBench's operations) speak. Roadmap M16.1.
 *
 * Pure, no Electron/DOM (the M4 harness pattern): message discrimination,
 * response construction, and a newline framer, each landing with a test. The
 * transport that pumps bytes through it is M16.2's, in the main process.
 *
 * Validated against `@zed-industries/agent-client-protocol@0.4.5`'s
 * `typescript/jsonrpc.ts` — the shapes match; PinBench carries its own copy so
 * `shared/` stays dependency-free.
 */

export type JsonRpcId = string | number

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResultResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: unknown
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0'
  /** `null` when the offending message had no usable id (e.g. a parse error). */
  id: JsonRpcId | null
  error: JsonRpcError
}

export type JsonRpcResponse = JsonRpcResultResponse | JsonRpcErrorResponse
export type JsonRpcMessage =
  JsonRpcRequest | JsonRpcNotification | JsonRpcResultResponse | JsonRpcErrorResponse

/** The standard JSON-RPC 2.0 error codes, plus the two ACP reserves. */
export const RpcErrorCode = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** ACP: authentication required (`RequestError::authRequired`). */
  authRequired: -32000,
  /** ACP: resource, such as a file, was not found. */
  resourceNotFound: -32002
} as const

/**
 * Thrown by a method handler to return a specific JSON-RPC error rather than
 * the generic internal-error wrapper {@link Dispatcher} applies to a raw throw.
 */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'RpcError'
  }

  static methodNotFound(method: string): RpcError {
    return new RpcError(RpcErrorCode.methodNotFound, 'Method not found', { method })
  }

  static invalidParams(detail: string): RpcError {
    return new RpcError(RpcErrorCode.invalidParams, `Invalid params: ${detail}`)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || typeof value === 'number'
}

export function isRequest(message: unknown): message is JsonRpcRequest {
  return (
    isObject(message) &&
    message['jsonrpc'] === '2.0' &&
    typeof message['method'] === 'string' &&
    isId(message['id'])
  )
}

export function isNotification(message: unknown): message is JsonRpcNotification {
  return (
    isObject(message) &&
    message['jsonrpc'] === '2.0' &&
    typeof message['method'] === 'string' &&
    !('id' in message)
  )
}

export function isResponse(message: unknown): message is JsonRpcResponse {
  return (
    isObject(message) &&
    message['jsonrpc'] === '2.0' &&
    isId(message['id']) &&
    ('result' in message || 'error' in message)
  )
}

export function resultResponse(id: JsonRpcId, result: unknown): JsonRpcResultResponse {
  return { jsonrpc: '2.0', id, result: result ?? null }
}

export function errorResponse(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcErrorResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data }
  }
}

export function request(id: JsonRpcId, method: string, params?: unknown): JsonRpcRequest {
  return params === undefined
    ? { jsonrpc: '2.0', id, method }
    : { jsonrpc: '2.0', id, method, params }
}

export function notification(method: string, params?: unknown): JsonRpcNotification {
  return params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }
}

export type ParsedFrame =
  { ok: true; message: JsonRpcMessage } | { ok: false; error: JsonRpcErrorResponse }

/** Parse one newline-delimited frame; a bad line yields a `null`-id parse error. */
export function parseFrame(line: string): ParsedFrame {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { ok: false, error: errorResponse(null, RpcErrorCode.parseError, 'Parse error') }
  }
  if (isRequest(value) || isNotification(value) || isResponse(value)) {
    return { ok: true, message: value }
  }
  const id = isObject(value) && isId(value['id']) ? value['id'] : null
  return { ok: false, error: errorResponse(id, RpcErrorCode.invalidRequest, 'Invalid request') }
}

/** Serialise a message as a single newline-terminated frame. */
export function encodeFrame(message: JsonRpcMessage): string {
  return JSON.stringify(message) + '\n'
}

/**
 * Newline framer for a byte/stdio transport: feed it arbitrary chunks, get
 * back complete lines, keep the trailing partial buffered. `\r\n` is treated
 * as a plain terminator; empty lines are dropped.
 */
export class NdjsonBuffer {
  private pending = ''

  push(chunk: string): string[] {
    this.pending += chunk
    const parts = this.pending.split('\n')
    this.pending = parts.pop() ?? ''
    return parts.map((line) => line.replace(/\r$/, '')).filter((line) => line.length > 0)
  }

  /** Any buffered non-empty remainder, e.g. on stream end without a final newline. */
  flush(): string | null {
    const rest = this.pending.replace(/\r$/, '')
    this.pending = ''
    return rest.length > 0 ? rest : null
  }
}
