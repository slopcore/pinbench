/**
 * The MCP control server core (roadmap M16.1) — pure, transport-agnostic.
 *
 * This is the channel that gives a coding agent "full control": PinBench runs
 * this server, lists it in the ACP `session/new` `mcpServers`, and the agent's
 * model then sees every {@link OPERATIONS} entry as a callable tool.
 *
 * {@link mcpHandlers} returns a JSON-RPC handler map for {@link Dispatcher};
 * the byte transport (stdio or a localhost HTTP endpoint) and the binding of
 * {@link McpToolInvoker} to the live Electron subsystems are M16.2's, in the
 * main process. Shapes follow the MCP `2025-06-18` schema.
 */

import type { RpcHandler } from './dispatch'
import { RpcError } from './jsonrpc'
import { MCP_PROTOCOL_VERSION } from './methods'
import {
  OPERATIONS,
  type OperationDescriptor,
  defaultPermissionPolicy,
  inputSchema,
  operation,
  parseParams
} from './operations'

export interface McpTextContent {
  type: 'text'
  text: string
}

export interface McpToolResult {
  content: McpTextContent[]
  isError?: boolean
  /** Machine-readable payload, mirrored from the operation's return value. */
  structuredContent?: unknown
}

/**
 * Performs one operation. Given the validated params, returns any
 * JSON-serialisable value (surfaced to the agent as text + structuredContent),
 * or throws — an {@link RpcError} carries its message through, anything else
 * becomes a generic failure. Bound to the real subsystems by the host.
 */
export type McpToolInvoker = (
  op: OperationDescriptor,
  params: Record<string, unknown>
) => Promise<unknown>

/**
 * Consulted before an operation runs. Return `false` to refuse — the tool call
 * comes back as an error the agent can read. Defaults to
 * {@link defaultPermissionPolicy} (refuse nothing it would `allow`, ask the
 * host for the rest); a host with no interactive user can pass a stub that
 * resolves `ask` however it likes.
 */
export type McpAuthorizer = (
  op: OperationDescriptor,
  params: Record<string, unknown>
) => Promise<boolean>

export interface McpServerOptions {
  serverName: string
  serverVersion: string
  invoke: McpToolInvoker
  authorize?: McpAuthorizer
}

function toolList(): { tools: { name: string; description: string; inputSchema: unknown }[] } {
  return {
    tools: OPERATIONS.map((op) => ({
      name: op.name,
      description: op.summary,
      inputSchema: inputSchema(op)
    }))
  }
}

function ok(value: unknown): McpToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2)
  return { content: [{ type: 'text', text }], structuredContent: value ?? null }
}

function fail(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

export function mcpHandlers(options: McpServerOptions): Record<string, RpcHandler> {
  const authorize: McpAuthorizer =
    options.authorize ?? (async (op) => defaultPermissionPolicy(op) !== 'deny')

  return {
    initialize: () => ({
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: options.serverName, version: options.serverVersion }
    }),

    'notifications/initialized': () => undefined,

    ping: () => ({}),

    'tools/list': () => toolList(),

    'tools/call': async (raw: unknown): Promise<McpToolResult> => {
      if (typeof raw !== 'object' || raw === null) {
        throw RpcError.invalidParams('tools/call expects an object')
      }
      const { name, arguments: args } = raw as { name?: unknown; arguments?: unknown }
      if (typeof name !== 'string') throw RpcError.invalidParams('tools/call requires "name"')

      const op = operation(name)
      if (!op) return fail(`Unknown tool: ${name}`)

      let params: Record<string, unknown>
      try {
        params = parseParams(op, args)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }

      if (!(await authorize(op, params))) {
        return fail(`Permission denied for "${op.name}".`)
      }

      try {
        return ok(await options.invoke(op, params))
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
    }
  }
}
