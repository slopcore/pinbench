import { describe, expect, it, vi } from 'vitest'
import { harness } from './harness'
import { KbdCoprocessorModel, kbdCoprocessorDescriptor } from './kbd-coprocessor'

describe('KbdCoprocessorModel', () => {
  it('starts idle driving KEY_INT high (1)', () => {
    const kbd = harness(new KbdCoprocessorModel())
    expect(kbd.snapshot()).toMatchObject({ lastKey: '', keyCount: 0, buffer: '', queueDepth: 0 })
    expect(kbd.line('KEY_INT')).toBe(1)
    expect(kbd.meter('keys')).toBe(0)
    expect(kbd.meter('queue')).toBe(0)
  })

  it('receives key command, buffers key and pulses KEY_INT low', () => {
    vi.useFakeTimers()
    try {
      const kbd = harness(new KbdCoprocessorModel({ pulseMs: 25 }))
      kbd.command('key', { key: 'UP' })

      expect(kbd.snapshot()).toMatchObject({ lastKey: 'UP', keyCount: 1, queueDepth: 1 })
      expect(kbd.line('KEY_INT')).toBe(0) // pulsed low
      expect(kbd.meter('keys')).toBe(1)
      expect(kbd.events.at(-1)).toMatchObject({ kind: 'key', summary: 'Key pressed: UP' })

      vi.advanceTimersByTime(25)
      expect(kbd.line('KEY_INT')).toBe(1) // released back high
    } finally {
      vi.useRealTimers()
    }
  })

  it('maintains a typing text buffer for printable characters and backspace', () => {
    const kbd = harness(new KbdCoprocessorModel())
    kbd.command('key', { key: 'H' })
    kbd.command('key', { key: 'E' })
    kbd.command('key', { key: 'L' })
    kbd.command('key', { key: 'L' })
    kbd.command('key', { key: 'O' })
    expect(kbd.snapshot()).toMatchObject({ buffer: 'HELLO', keyCount: 5 })

    kbd.command('key', { key: 'BKSP' })
    expect(kbd.snapshot()).toMatchObject({ buffer: 'HELL', keyCount: 6 })

    kbd.command('key', { key: 'SPACE' })
    kbd.command('key', { key: 'ENTER' })
    expect(kbd.snapshot()).toMatchObject({ buffer: 'HELL ⏎', keyCount: 8 })
  })

  it('resets state and drives KEY_INT high', () => {
    const kbd = harness(new KbdCoprocessorModel())
    kbd.command('key', { key: 'RIGHT' })
    kbd.reset()
    expect(kbd.snapshot()).toMatchObject({ lastKey: '', keyCount: 0, buffer: '', queueDepth: 0 })
    expect(kbd.line('KEY_INT')).toBe(1)
  })

  it('is registered under pinbench.kbd-coprocessor descriptor', () => {
    expect(kbdCoprocessorDescriptor.id).toBe('pinbench.kbd-coprocessor')
    expect(kbdCoprocessorDescriptor.create().id).toBe('pinbench.kbd-coprocessor')
  })
})
