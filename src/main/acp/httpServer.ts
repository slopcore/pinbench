/**
 * The MCP control server over loopback HTTP (roadmap M16.2).
 *
 * A coding agent reaches PinBench's operations by POSTing JSON-RPC to this
 * endpoint — the `mcpServers` entry PinBench lists at `session/new` points
 * here (see {@link ../../shared/acp/session}.httpMcpServer). The agent-side
 * ACP connection that spawns the agent and does the prompt turn is M16.3.
 *
 * Security posture (ADR 0002), enforced here:
 *  - binds `127.0.0.1` explicitly — never `::`, never all interfaces;
 *  - every request must carry `Authorization: Bearer <token>`;
 *  - any `Origin` header that is not loopback is refused, so a browser page on
 *    the same machine cannot drive the port;
 *  - a rejected request gets `403` with no body.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { Dispatcher } from '../../shared/acp/dispatch'
import { parseFrame } from '../../shared/acp/jsonrpc'
import { mcpHandlers, type McpAuthorizer } from '../../shared/acp/mcp'
import type { McpToolInvoker } from '../../shared/acp/mcp'

const MAX_BODY_BYTES = 1 << 20 // 1 MiB — MCP requests are small

export interface AcpControlServerOptions {
  serverName: string
  serverVersion: string
  invoke: McpToolInvoker
  /** The permission gate. Omit and every `exec` op is refused (fail closed). */
  authorize?: McpAuthorizer
  /** Fixed bearer token; a random 32-byte hex string when omitted. */
  token?: string
  /** Listen port; `0` (default) picks a free ephemeral port. */
  port?: number
}

export interface AcpControlServerHandle {
  readonly url: string
  readonly token: string
  readonly port: number
  close(): Promise<void>
}

function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return true
  try {
    const { hostname } = new URL(origin)
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  } catch {
    return false
  }
}

export function startAcpControlServer(
  options: AcpControlServerOptions
): Promise<AcpControlServerHandle> {
  const token = options.token ?? randomBytes(32).toString('hex')
  const dispatcher = new Dispatcher(
    mcpHandlers({
      serverName: options.serverName,
      serverVersion: options.serverVersion,
      invoke: options.invoke,
      ...(options.authorize ? { authorize: options.authorize } : {})
    })
  )

  const server = createServer((req, res) => {
    const deny = (code: number): void => {
      res.writeHead(code)
      res.end()
    }

    if (req.method !== 'POST' || (req.url ?? '/') !== '/mcp') return deny(404)
    if (req.headers.authorization !== `Bearer ${token}`) return deny(403)
    if (!isLoopbackOrigin(req.headers.origin)) return deny(403)

    let body = ''
    let tooBig = false
    req.on('data', (chunk: Buffer) => {
      body += chunk
      if (body.length > MAX_BODY_BYTES) {
        tooBig = true
        req.destroy()
      }
    })
    req.on('end', () => {
      if (tooBig) return
      void handle(body)
    })

    const handle = async (raw: string): Promise<void> => {
      const parsed = parseFrame(raw)
      if (!parsed.ok) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(parsed.error))
        return
      }
      const message = parsed.message
      if (!('method' in message)) return deny(400)
      const response = await dispatcher.handle(message)
      res.writeHead(response ? 200 : 202, response ? { 'content-type': 'application/json' } : {})
      res.end(response ? JSON.stringify(response) : undefined)
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        token,
        port,
        close: () => closeServer(server)
      })
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections?.()
  })
}
