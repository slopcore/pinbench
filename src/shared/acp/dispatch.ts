/**
 * The pure request router (roadmap M16.1). A {@link Dispatcher} maps a
 * JSON-RPC method name to a handler and turns the handler's return value — or
 * its throw — into the right response frame. It knows nothing about the
 * transport: M16.2 feeds it parsed messages and writes back what it returns.
 *
 * Used for both wires: the ACP client handlers (`fs/read_text_file`, …) and
 * the MCP control server (`tools/call`, …) are each just a handler map.
 */

import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from './jsonrpc'
import { RpcError, RpcErrorCode, errorResponse, resultResponse } from './jsonrpc'

export type RpcHandler = (params: unknown) => unknown | Promise<unknown>

export class Dispatcher {
  private readonly handlers = new Map<string, RpcHandler>()

  constructor(handlers: Record<string, RpcHandler> = {}) {
    for (const [method, handler] of Object.entries(handlers)) this.handlers.set(method, handler)
  }

  /** Register (or replace) a handler. Returns `this` for chaining. */
  on(method: string, handler: RpcHandler): this {
    this.handlers.set(method, handler)
    return this
  }

  has(method: string): boolean {
    return this.handlers.has(method)
  }

  /**
   * Route one message. Returns the response frame for a request, or `null` for
   * a notification (JSON-RPC forbids replying to those) and for an unknown
   * notification method.
   */
  async handle(message: JsonRpcRequest | JsonRpcNotification): Promise<JsonRpcResponse | null> {
    const isRequest = 'id' in message
    const handler = this.handlers.get(message.method)

    if (!handler) {
      return isRequest
        ? errorResponse(message.id, RpcErrorCode.methodNotFound, 'Method not found', {
            method: message.method
          })
        : null
    }

    try {
      const result = await handler(message.params)
      return isRequest ? resultResponse(message.id, result) : null
    } catch (error) {
      if (!isRequest) return null
      if (error instanceof RpcError) {
        return errorResponse(message.id, error.code, error.message, error.data)
      }
      const detail = error instanceof Error ? error.message : String(error)
      return errorResponse(message.id, RpcErrorCode.internalError, detail)
    }
  }
}
