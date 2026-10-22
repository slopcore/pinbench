---
title: Agent control plane (ACP + MCP)
area: agent
status: working
status_note: 'core + binding + agent connection + dock panel + stdio bridge done; live run vs. a real agent binary still owed'
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

| Module                                                             | Role                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/acp/`                                                  | Pure core: JSON-RPC 2.0 framing + ndjson buffer, method/version tables, a transport-agnostic router, the operation catalogue with per-field validation + JSON-Schema emit + risk model, the MCP control-server core, the ACP session builders.                                                                                                                              |
| `src/main/acp/invoker.ts`                                          | One switch mapping every catalogue entry onto an injected `PinBenchAcpDeps`. An exhaustiveness test asserts no operation falls through, so catalogue and binding cannot drift.                                                                                                                                                                                              |
| `src/main/acp/httpServer.ts`                                       | The MCP server over loopback HTTP (`127.0.0.1`, bearer token, origin check, fail-closed).                                                                                                                                                                                                                                                                                   |
| `src/main/acp/connection.ts`                                       | `AcpConnection` — a symmetric JSON-RPC 2.0 peer over a line transport, both directions interleaving.                                                                                                                                                                                                                                                                        |
| `src/main/acp/agent.ts`                                            | `spawnAgent()` — wraps the child's stdio as a transport, stderr forwarded.                                                                                                                                                                                                                                                                                                  |
| `src/main/acp/agentSession.ts`                                     | `initialize` → `session/new` (listing the MCP control server) → `session/prompt`; serves `fs/read_text_file` (through `ProjectFiles.guard()`; `fs/write_text_file` is not advertised or served — firmware source is the IDE's), `session/request_permission`, `session/update`; `cancel()`.                                                                                 |
| `src/main/acp/bridge.ts`                                           | Assembles deps from the live `EmulatorSupervisor` / `BuildRunner` / `DeviceHost` / `ProjectFiles` + the main-held board, composes the permission gate, spawns the agent, drives the session, exposes `bridge.prompt(text)`, kills the child on dispose.                                                                                                                     |
| `src/shared/acp/sessionUpdate.ts`                                  | Types the `session/update` discriminated union and reduces the stream to an `AgentTurn` — assistant / thought text runs, **tool calls merged by `toolCallId`** (never appended), the plan, session metadata. Pure and Electron-free, so the dock panel just renders the reduced value.                                                                                      |
| `src/renderer/src/components/AgentPanel.tsx` + `state/useAgent.ts` | The dock's **Agent** tab: the running turn, a prompt box (→ `bridge.prompt`), a Stop button (→ `session.cancel()`), the auto-approve policy toggle, and inline permission prompts. `useAgent` pushes `agent:panel-present` so the bridge routes approvals inline, replays the buffered turn on mount, and folds each update through the shared reducer.                     |
| `scripts/pinbench-mcp.mjs`                                         | The stdio↔loopback-HTTP shim an MCP client that only speaks the `Stdio` transport spawns: reads JSON-RPC lines on stdin, POSTs each to the control server with the bearer token, relays the reply. Registered once with `claude mcp add pinbench -- node <repo>/scripts/pinbench-mcp.mjs`; re-reads `/tmp/pinbench-acp.json` per request so it survives a PinBench restart. |

## Operations live now

`app_info`; `board_get` / `board_verify` / `board_edit` / `board_undo` /
`board_redo` (against a `BoardHistory` the **main process** owns — every mutation
re-`load`s the device host); `pinmap_preview` (header text, never written);
`firmware_actions` (the required firmware changes, recomputed per call —
[[firmware-actions]]); `project_open`; `build_start` /
`build_cancel` / `build_clean` / `build_status`; `emulator_start` (path or
`lastFirmware()`) / `stop` / `reset` / `status`; `serial_write` / `serial_read`;
`device_snapshots` / `device_command`; `menu_command` (id checked against the
command table).

No operation reads or writes firmware source: an IDE agent uses its own file
tools for that, and calls `firmware_actions` to learn what PinBench needs.
`project_tree`, `project_read_file` and `pinmap_write` were removed when code
moved out of PinBench. The in-app agent's `fs/read_text_file` path is gated by
`ProjectFiles.guard()` — a `../` path escaping
the project root is refused (the one security claim the ADR makes about the agent
connection, tested).

## Permission surfaces

An `exec` operation and an ACP `session/request_permission` both resolve through
the same gate. When the dock's Agent panel is mounted the prompt renders inline
there (Allow once / Allow for session / Always allow / Deny, plus any
agent-supplied options); when it is not, the main process falls back to a native
`dialog.showMessageBox` with the same four outcomes — so a panel-less or headless
run never hangs. `session` / `always` widen `acpSessionAutoApprove` /
`acpAutoApprove` exactly as the menu checkbox does.

## Deliberately out of scope

`terminal/*` — the client capability stays `terminal: false`. ADR 0002 froze the
operation surface to `PinBenchApi` + `BoardEdit`; `terminal/*` would hand the
agent arbitrary command execution through PinBench, which that decision
excludes. An agent that needs a shell runs it itself, in its own sandbox.

The live run against a real ACP agent binary (Zed's agent, Gemini CLI) is still
owed — it needs such a binary installed. The full turn is covered in-memory: a
scripted fake agent streams a realistic `session/update` sequence + a
`session/request_permission`, and `src/main/acp/agentSession.test.ts` asserts the
captured stream reduces to the expected `AgentTurn`. `scripts/pinbench-mcp.mjs`
is exercised as a child process against a real control server in
`src/main/acp/stdioBridge.test.ts`.
