/**
 * The method names and version numbers on the two wires PinBench's agent
 * bridge speaks (roadmap M16.1):
 *
 *  - **ACP** — PinBench is the *Client*; a coding agent runs as the *Agent*
 *    subprocess. Client sends `initialize` / `session/new` / `session/prompt`;
 *    Agent calls back with `fs/*`, `terminal/*`, `session/request_permission`
 *    and streams `session/update`.
 *  - **MCP** — the channel that actually hands PinBench's operations to the
 *    agent. PinBench runs an MCP server (see {@link ./mcp}) and lists it in
 *    `session/new`'s `mcpServers`, so the agent's model can call
 *    `emulator_start`, `board_edit`, `build_start`, … as tools.
 *
 * Constants transcribed from `@zed-industries/agent-client-protocol@0.4.5`
 * (`AGENT_METHODS`, `CLIENT_METHODS`, `PROTOCOL_VERSION`) and the MCP
 * `2025-06-18` schema. Kept as a local copy so `shared/` takes no dependency.
 */

/** ACP major protocol version (an integer, per the spec). */
export const ACP_PROTOCOL_VERSION = 1

/** MCP protocol revision PinBench's control server implements. */
export const MCP_PROTOCOL_VERSION = '2025-06-18'

/** Methods a Client sends to an Agent. */
export const AgentMethod = {
  initialize: 'initialize',
  authenticate: 'authenticate',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionSetMode: 'session/set_mode'
} as const

/** Methods an Agent sends back to a Client. */
export const ClientMethod = {
  fsReadTextFile: 'fs/read_text_file',
  fsWriteTextFile: 'fs/write_text_file',
  sessionRequestPermission: 'session/request_permission',
  sessionUpdate: 'session/update',
  terminalCreate: 'terminal/create',
  terminalOutput: 'terminal/output',
  terminalRelease: 'terminal/release',
  terminalWaitForExit: 'terminal/wait_for_exit',
  terminalKill: 'terminal/kill'
} as const

/** MCP methods PinBench's control server answers. */
export const McpMethod = {
  initialize: 'initialize',
  initialized: 'notifications/initialized',
  toolsList: 'tools/list',
  toolsCall: 'tools/call',
  ping: 'ping'
} as const

/**
 * Prefix for PinBench-specific ACP extension methods (the spec reserves a
 * leading `_`). A PinBench-aware client can call `_pinbench/<op>` directly on
 * the ACP connection instead of going through MCP tool calls; both routes
 * resolve to the same operation catalogue.
 */
export const PINBENCH_EXT_PREFIX = '_pinbench/'

export type AgentMethodName = (typeof AgentMethod)[keyof typeof AgentMethod]
export type ClientMethodName = (typeof ClientMethod)[keyof typeof ClientMethod]
export type McpMethodName = (typeof McpMethod)[keyof typeof McpMethod]
