/**
 * ACP session setup, from PinBench's seat as the *Client* (roadmap M16.1).
 *
 * Pure request builders and the version handshake: the main process (M16.2)
 * spawns the agent, opens an ndjson stream to it, sends {@link initializeParams}
 * then {@link newSessionParams}, and serves the agent's callbacks. The MCP
 * server that carries PinBench's operations is listed here so the agent
 * connects to it as part of `session/new`.
 */

import { ACP_PROTOCOL_VERSION } from './methods'

export interface ClientInfo {
  name: string
  version: string
  title?: string
}

/**
 * Capabilities PinBench advertises to the agent. It can read files in the open
 * project but not write them: firmware source is edited in the external IDE,
 * never through PinBench.
 * `terminal` is advertised only when the host wires a terminal provider — the
 * agent-session core lands `fs/*` first (M16.3); terminal follows.
 */
export interface AcpClientCapabilities {
  fs: { readTextFile: boolean; writeTextFile: boolean }
  terminal: boolean
}

export const PINBENCH_CLIENT_CAPABILITIES: AcpClientCapabilities = {
  fs: { readTextFile: true, writeTextFile: false },
  terminal: false
}

export interface InitializeParams {
  protocolVersion: number
  clientCapabilities: AcpClientCapabilities
  clientInfo: ClientInfo
}

export function initializeParams(
  clientInfo: ClientInfo,
  capabilities: AcpClientCapabilities = PINBENCH_CLIENT_CAPABILITIES
): InitializeParams {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: capabilities,
    clientInfo
  }
}

/**
 * Pick the protocol version to use: the highest both sides know, never above
 * ours, never below 1. An agent that omits or low-balls the number gets ours.
 */
export function negotiateVersion(agentProtocolVersion: unknown): number {
  const theirs =
    typeof agentProtocolVersion === 'number' && Number.isInteger(agentProtocolVersion)
      ? agentProtocolVersion
      : ACP_PROTOCOL_VERSION
  return Math.max(1, Math.min(ACP_PROTOCOL_VERSION, theirs))
}

export interface HttpMcpServer {
  type: 'http'
  name: string
  url: string
  headers: { name: string; value: string }[]
}

/** The `mcpServers` entry pointing the agent at PinBench's control server. */
export function httpMcpServer(name: string, url: string, token?: string): HttpMcpServer {
  return {
    type: 'http',
    name,
    url,
    headers: token ? [{ name: 'Authorization', value: `Bearer ${token}` }] : []
  }
}

export interface NewSessionParams {
  cwd: string
  mcpServers: HttpMcpServer[]
}

/**
 * `session/new` params: the working directory is the open project, and the one
 * MCP server is PinBench itself.
 */
export function newSessionParams(cwd: string, controlServer: HttpMcpServer): NewSessionParams {
  return { cwd, mcpServers: [controlServer] }
}
