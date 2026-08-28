import { describe, expect, it } from 'vitest'
import { canTransition, transition, INITIAL_STATUS } from './emulator'
import type { EmulatorState } from './emulator'

describe('emulator state machine', () => {
  it('starts idle', () => {
    expect(INITIAL_STATUS.state).toBe('idle')
  })

  const validPaths: [EmulatorState, EmulatorState][] = [
    ['idle', 'starting'],
    ['starting', 'running'],
    ['starting', 'crashed'],
    ['starting', 'stopping'],
    ['running', 'stopping'],
    ['running', 'crashed'],
    ['stopping', 'idle'],
    ['stopping', 'crashed'],
    ['crashed', 'starting'],
    ['crashed', 'idle']
  ]

  for (const [from, to] of validPaths) {
    it(`allows ${from} → ${to}`, () => {
      expect(canTransition(from, to)).toBe(true)
      expect(transition(from, to)).toBe(to)
    })
  }

  const invalidPaths: [EmulatorState, EmulatorState][] = [
    ['idle', 'running'],
    ['idle', 'stopping'],
    ['idle', 'crashed'],
    ['running', 'starting'],
    ['running', 'idle'],
    ['crashed', 'running'],
    ['crashed', 'stopping']
  ]

  for (const [from, to] of invalidPaths) {
    it(`rejects ${from} → ${to}`, () => {
      expect(canTransition(from, to)).toBe(false)
      expect(() => transition(from, to)).toThrow('Invalid emulator transition')
    })
  }
})
