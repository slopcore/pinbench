# ADR 0002 — The agent control plane: ACP Client + an MCP control server

- **Status.** Accepted
- **Date.** 2026-08-29
- **Milestone.** M16 (Agent Client Protocol)
- **Supersedes.** Nothing.

## Context

We want a coding agent — Zed's agent, Gemini CLI, Claude Code, anything that
speaks a standard agent protocol — to be able to drive PinBench end to end:
open a project, edit the wiring canvas, verify the pin map, build & flash, boot
the emulator, read the serial console, stimulate a device model. "Full control
over the software", using the same operations the app's own UI drives and no
more.

The [Agent Client Protocol](https://agentclientprotocol.com) (ACP) is the
obvious wire. It is JSON-RPC 2.0 over stdio between a **Client** (an editor)
and an **Agent** (the AI coding tool). PinBench is the Client; the agent runs
as a subprocess we spawn.

The catch is that ACP's **client-side** method set is small and fixed —
`fs/read_text_file`, `fs/write_text_file`, `session/request_permission`,
`session/update`, `terminal/*`. None of it says "start the emulator" or
"rebind GPIO16". So adopting ACP is necessary but not sufficient; something has
to carry PinBench's own operations to the agent.

Two channels can do that:

1. **An MCP server listed in `session/new`.** ACP's sanctioned extension route:
   `NewSessionRequest.mcpServers` hands the agent extra tool servers, and the
   agent's model then calls those tools during a prompt turn. Works with a
   **stock** agent — nothing about the agent needs to know it is PinBench.

   One caveat this ADR is explicit about: an in-process server is reachable
   over **HTTP**, and HTTP MCP is *agent-advertised* (`agentCapabilities.
   mcpCapabilities.http`). An agent that supports only the mandatory `Stdio`
   MCP transport cannot connect to a loopback URL. The fallback is a tiny
   `pinbench-mcp` bridge executable shipped in the package — a Node script the
   agent spawns as a `Stdio` server, which proxies stdin/stdout to PinBench's
   loopback HTTP server (bearer token in the env). M16.2 ships the HTTP server;
   the bridge script is M16.3 unless a stdio-only agent forces it sooner.
2. **`_`-prefixed ACP extension methods** (`_pinbench/build`, …). Simpler on
   the wire (reuses the ACP connection), but only a **PinBench-aware** client
   would ever call them; a stock agent will not.

## Decision

**PinBench is the ACP Client. Its operation surface is delivered to the agent
as an in-process MCP server, listed in every `session/new`.** The
`_pinbench/*` extension methods are kept as a secondary path for a
PinBench-aware client, resolving to the same catalogue, but the MCP server is
the one that matters and the one we test.

### Scope boundary

The agent-facing surface is exactly **the `PinBenchApi` interface in
`src/shared/ipc.ts` plus the `BoardEdit` transforms in
`src/shared/boardEdit.ts`** — enumerated as `OPERATIONS` in
`src/shared/acp/operations.ts`. Not "arbitrary code", not a shell. If the UI
cannot do it, the agent cannot either. New app capability is added to that list
deliberately, with its risk class.

### Risk classes and the permission gate

Every operation is `read`, `write`, or `exec`:

| Class | Meaning | Default policy |
|---|---|---|
| `read` | observes state, no side effects | auto-approve |
| `write` | mutates the in-memory board document; reversible via `board_undo` | auto-approve |
| `exec` | spawns `pio`/QEMU, writes a file, or drives emulated hardware | **prompt the user** |

The gate is a policy function, so a host can override it (ask-for-everything
while unattended, allow-all in a trusted CI run).

### Transport and exposure

- **Opt-in only.** No agent bridge unless PinBench is started with `--acp` (or
  `PINBENCH_ACP=1`). A normal launch is unchanged.
- **Loopback / local only.** The ACP link to the agent is stdio. The MCP
  control server binds `127.0.0.1` **explicitly** (never `::`, never an omitted
  host) on an ephemeral port, never a routable interface. Every request must
  carry the per-session bearer token *and* an `Origin` that is absent or
  loopback — a browser page on the user's machine can otherwise POST to the
  port. A rejected request gets `403`, no body.
- **Same gating as the bridge.** Every filesystem path an operation touches is
  checked with `isOpenProject()` / `ProjectFiles.guard()`, exactly as
  `build:start` and `project:*` already are. The agent gets the project the
  user opened, nothing above it.

### Board-document ownership

`board_edit` / `board_undo` / `board_redo` mutate the board. Once M11.3's
canvas UI lands, the renderer owns a `BoardHistory`; a second history in the
main process would silently diverge from it (an agent edit and a canvas edit
would each win locally). **Decision: the main process is the single authority
on the board document while an agent session is active.** M11.3's canvas must
read its history from main (over IPC) rather than hold its own, the same way
the board *definition* already loads in main and is handed to `DeviceHost`
without a renderer round-trip. Until that wiring exists (M16.3), the three
board-mutation operations are in the catalogue but the M16.2 invoker answers
them with a plain "not available in this build" error — `board_get`,
`board_verify` and `pinmap_preview` (all reads) are live.

### No new runtime dependency

`src/shared/acp/` reimplements the ~200 lines of JSON-RPC / ACP / MCP framing
it needs rather than taking `@zed-industries/agent-client-protocol` (which
pulls `zod`). This matches how M7.1 wrote the LR1110 contract from RadioLib's
source rather than vendoring RadioLib. The official package and the MCP
`2025-06-18` schema are the references the code and its tests were checked
against; the constant tables in `methods.ts` are transcribed from them.

## What this ADR does not decide

- The agent-session UI (a dock panel showing the turn, its tool calls, and the
  permission prompts) — M16.3.
- Whether PinBench ever also acts as an ACP **Agent** (exposing itself to an
  editor). Out of scope; the goal is agents driving PinBench, not the reverse.
- Multi-agent or remote agents. One local agent subprocess at a time.

## Consequences

- The pure core (`src/shared/acp/`, M16.1) is testable with no Electron and no
  agent: framing, the dispatcher, the operation catalogue, the MCP server
  core, and the session builders each land with unit tests (M4 harness
  pattern).
- The main-process binding (M16.2) is the only place that imports QEMU / `pio`
  / the device host into the bridge, and it is small: a transport plus one
  `McpToolInvoker` switch mapping `OPERATIONS` onto the existing supervisors.
- A stock coding agent, pointed at PinBench with `--acp`, can run a prompt like
  *"wire the LR1110's BUSY line to GPIO34, verify, and flash m9"* and have it
  execute — each `exec` step gated by a prompt unless the user relaxed the
  policy.
