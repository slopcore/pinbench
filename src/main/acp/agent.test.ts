import { describe, expect, it } from 'vitest'
import { agentCommandFromEnv } from './agent'

describe('agentCommandFromEnv', () => {
  it('is null when PINBENCH_AGENT_CMD is unset or blank', () => {
    expect(agentCommandFromEnv({})).toBeNull()
    expect(agentCommandFromEnv({ PINBENCH_AGENT_CMD: '   ' })).toBeNull()
  })

  it('reads the command and space-split args', () => {
    expect(
      agentCommandFromEnv({
        PINBENCH_AGENT_CMD: 'my-agent',
        PINBENCH_AGENT_ARGS: '--acp --model x'
      })
    ).toEqual({ command: 'my-agent', args: ['--acp', '--model', 'x'] })
  })

  it('defaults args to an empty list', () => {
    expect(agentCommandFromEnv({ PINBENCH_AGENT_CMD: 'agent' })).toEqual({
      command: 'agent',
      args: []
    })
  })
})
