/**
 * Spawning the agent subprocess and wrapping its stdio as a {@link
 * LineTransport} for {@link AcpConnection} (roadmap M16.3).
 *
 * The agent to run is configured out of band — `PINBENCH_AGENT_CMD` (with
 * optional `PINBENCH_AGENT_ARGS`, space-split). No default: without a
 * configured command the bridge stands up the control server but starts no
 * session.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import type { LineTransport } from './connection'

export interface AgentCommand {
  command: string
  args: string[]
}

/** Read the configured agent command, or `null` when none is set. */
export function agentCommandFromEnv(env = process.env): AgentCommand | null {
  const command = env['PINBENCH_AGENT_CMD']?.trim()
  if (!command) return null
  const args = (env['PINBENCH_AGENT_ARGS'] ?? '').trim()
  return { command, args: args ? args.split(/\s+/) : [] }
}

export interface SpawnedAgent {
  transport: LineTransport
  pid: number | undefined
  kill(): void
}

/**
 * Launch the agent and expose its stdin/stdout as a line transport. stderr is
 * forwarded to the host process's stderr so the agent's own logging is
 * visible. `cwd` is the open project.
 */
export function spawnAgent(cmd: AgentCommand, cwd: string, env = process.env): SpawnedAgent {
  const child: ChildProcessWithoutNullStreams = spawn(cmd.command, cmd.args, {
    cwd,
    env: { ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  }) as ChildProcessWithoutNullStreams

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => process.stderr.write(`[agent] ${chunk}`))

  const transport: LineTransport = {
    onData: (listener) => child.stdout.on('data', (chunk: string) => listener(chunk)),
    onClose: (listener) => {
      child.on('exit', listener)
      child.on('error', listener)
    },
    write: (frame) => {
      if (child.stdin.writable) child.stdin.write(frame)
    },
    close: () => {
      if (!child.killed) child.kill()
    }
  }

  return {
    transport,
    pid: child.pid,
    kill: () => {
      if (!child.killed) child.kill()
    }
  }
}
