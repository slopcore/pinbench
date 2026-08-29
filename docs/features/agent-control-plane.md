---
title: Agent control plane (ACP + MCP)
area: agent
status: partial
status_note: 'core + binding + agent connection done; dock panel + stdio bridge (M16.4) pending'
---

# Agent control plane (ACP + MCP)

A stock coding agent — Zed's agent, Gemini CLI, Claude Code — can drive PinBench
end to end: open a project, edit the canvas, verify, build & flash, boot the
emulator, read serial, stimulate a device model. The same operations the UI
drives, and no more. Decision of record: [ADR 0002](../adr/0002-acp-control-plane.md).

## Shape

- PinBench is the ACP **Client**; the agent runs as a subprocess PinBench spawns
  (`PINBENCH_AGENT_CMD` / `PINBENCH_AGENT_ARGS`).
- PinBench's operation surface — the `PinBenchApi` interface + the `BoardEdit`
  transforms — is handed to the agent as an **in-process MCP server** listed in
  `session/new`, so a stock agent's model sees each operation as a tool.
- **Opt-in** behind `--acp` / `PINBENCH_ACP`. Loopback / Unix-socket only, a
  per-session bearer token, never a routable bind. Non-loopback `Origin` refused,
  body capped at 1 MiB, `403` with no body on any failure.
- Every operation carries a `read` / `write` / `exec` risk class. `read`/`write`
  auto-approve; `exec` prompts through the host's `confirm` by default.

## Layers

| Module                         | Role                                                                                                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/acp/`              | Pure core: JSON-RPC 2.0 framing + ndjson buffer, method/version tables, a transport-agnostic router, the operation catalogue with per-field validation + JSON-Schema emit + risk model, the MCP control-server core, the ACP session builders.          |
| `src/main/acp/invoker.ts`      | One switch mapping every catalogue entry onto an injected `PinBenchAcpDeps`. An exhaustiveness test asserts no operation falls through, so catalogue and binding cannot drift.                                                                          |
| `src/main/acp/httpServer.ts`   | The MCP server over loopback HTTP (`127.0.0.1`, bearer token, origin check, fail-closed).                                                                                                                                                               |
| `src/main/acp/connection.ts`   | `AcpConnection` — a symmetric JSON-RPC 2.0 peer over a line transport, both directions interleaving.                                                                                                                                                    |
| `src/main/acp/agent.ts`        | `spawnAgent()` — wraps the child's stdio as a transport, stderr forwarded.                                                                                                                                                                              |
| `src/main/acp/agentSession.ts` | `initialize` → `session/new` (listing the MCP control server) → `session/prompt`; serves `fs/read_text_file`, `fs/write_text_file` (both through `ProjectFiles.guard()`), `session/request_permission`, `session/update`; `cancel()`.                   |
| `src/main/acp/bridge.ts`       | Assembles deps from the live `EmulatorSupervisor` / `BuildRunner` / `DeviceHost` / `ProjectFiles` + the main-held board, composes the permission gate, spawns the agent, drives the session, exposes `bridge.prompt(text)`, kills the child on dispose. |

## Operations live now

`app_info`; `board_get` / `board_verify` / `board_edit` / `board_undo` /
`board_redo` (against a `BoardHistory` the **main process** owns — every mutation
re-`load`s the device host); `pinmap_preview`; `project_open` / `project_tree` /
`project_read_file`; `build_start` / `build_cancel` / `build_clean` /
`build_status`; `emulator_start` (path or `lastFirmware()`) / `stop` / `reset` /
`status`; `serial_write` / `serial_read`; `device_snapshots` / `device_command`;
`menu_command` (id checked against the command table).

All filesystem paths are gated by `ProjectFiles.guard()` — a `../` path escaping
the project root is refused (the one security claim the ADR makes about the agent
connection, tested).

## Not yet (M16.4)

A dock panel showing the running turn, each tool call/result, inline permission
prompts, a stop button, and the policy control. The `pinbench-mcp` stdio→HTTP
bridge executable for agents that only support the `Stdio` MCP transport.
`pinmap_write` wired to the canvas header path. `terminal/*`.
