import { describe, expect, it, vi } from 'vitest'
import { harness } from './harness'
import { ButtonModel, buttonDescriptor } from './button'

describe('ButtonModel', () => {
  it('starts unpressed and driving high for an active-low button', () => {
    const btn = harness(new ButtonModel())
    expect(btn.snapshot()).toMatchObject({ pressed: false, pin: 1, presses: 0 })
    expect(btn.line('BTN')).toBe(1)
    expect(btn.meter('presses')).toBe(0)
    expect(btn.meter('state')).toBe(0)
  })

  it('starts unpressed and driving low for an active-high button', () => {
    const btn = harness(new ButtonModel({ activeLow: false }))
    expect(btn.snapshot()).toMatchObject({ pressed: false, pin: 0, presses: 0 })
    expect(btn.line('BTN')).toBe(0)
  })

  it('drives active-low pin low on press and high on release', () => {
    const btn = harness(new ButtonModel())
    btn.command('press', { down: true })
    expect(btn.snapshot()).toMatchObject({ pressed: true, pin: 0, presses: 1 })
    expect(btn.line('BTN')).toBe(0)
    expect(btn.meter('state')).toBe(1)
    expect(btn.meter('presses')).toBe(1)
    expect(btn.events.at(-1)).toMatchObject({ kind: 'press', summary: 'Button pressed (down)' })

    btn.command('press', { down: false })
    expect(btn.snapshot()).toMatchObject({ pressed: false, pin: 1, presses: 1 })
    expect(btn.line('BTN')).toBe(1)
    expect(btn.meter('state')).toBe(0)
    expect(btn.events.at(-1)).toMatchObject({ kind: 'press', summary: 'Button released (up)' })
  })

  it('handles holdMs auto-release timer', () => {
    vi.useFakeTimers()
    try {
      const btn = harness(new ButtonModel())
      btn.command('press', { holdMs: 1000 })
      expect(btn.snapshot()).toMatchObject({ pressed: true, pin: 0, presses: 1 })
      expect(btn.line('BTN')).toBe(0)

      vi.advanceTimersByTime(1000)
      expect(btn.snapshot()).toMatchObject({ pressed: false, pin: 1 })
      expect(btn.line('BTN')).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('handles click command', () => {
    vi.useFakeTimers()
    try {
      const btn = harness(new ButtonModel())
      btn.command('click')
      expect(btn.snapshot()).toMatchObject({ pressed: true, pin: 0, presses: 1 })

      vi.advanceTimersByTime(100)
      expect(btn.snapshot()).toMatchObject({ pressed: false, pin: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('handles setParam pressed update', () => {
    const btn = harness(new ButtonModel())
    btn.command('setParam', { pressed: true })
    expect(btn.snapshot()).toMatchObject({ pressed: true, pin: 0 })
    btn.command('setParam', { pressed: false })
    expect(btn.snapshot()).toMatchObject({ pressed: false, pin: 1 })
  })

  it('clears state on reset', () => {
    const btn = harness(new ButtonModel())
    btn.command('press', { down: true })
    expect(btn.snapshot()).toMatchObject({ pressed: true })
    btn.reset()
    expect(btn.snapshot()).toMatchObject({ pressed: false, pin: 1, presses: 0 })
    expect(btn.line('BTN')).toBe(1)
  })

  it('warns on unrecognized command', () => {
    const btn = harness(new ButtonModel())
    btn.command('unknown')
    expect(btn.diagnostics.at(-1)).toMatchObject({ severity: 'warn' })
  })

  it('is registered under pinbench.button descriptor', () => {
    expect(buttonDescriptor.id).toBe('pinbench.button')
    expect(buttonDescriptor.create().id).toBe('pinbench.button')
  })
})
