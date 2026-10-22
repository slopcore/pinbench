/**
 * Agent Client Protocol support for PinBench (roadmap M16).
 *
 * PinBench is the ACP *Client*; a coding agent runs as the *Agent* subprocess
 * and reaches PinBench's operations through the MCP control server here. This
 * barrel is the pure core (M16.1); the transport and the binding to QEMU /
 * `pio` / the device host live in `src/main/acp/` (M16.2).
 *
 * See `docs/adr/0002-acp-control-plane.md`.
 */

export * from './jsonrpc'
export * from './methods'
export * from './dispatch'
export * from './operations'
export * from './mcp'
export * from './session'
export * from './sessionUpdate'
