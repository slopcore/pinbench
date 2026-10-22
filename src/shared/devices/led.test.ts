import { describe, expect, it } from 'vitest'
import { harness } from './harness'
import { LedModel, ledDescriptor } from './led'

describe('LedModel', () => {
  it('starts dark for an active-high LED', () => {
    const led = harness(new LedModel())
    expect(led.snapshot()).toMatchObject({ lit: false, edges: 0 })
  })

  it('starts lit for an active-low LED', () => {
    const led = harness(new LedModel({ activeHigh: false }))
    expect(led.snapshot()).toMatchObject({ lit: true, pin: 0 })
  })

  it('lights on a rising edge and logs it', () => {
    const led = harness(new LedModel())
    led.signal('ANODE', 1)
    expect(led.snapshot()).toMatchObject({ lit: true, pin: 1, edges: 1 })
    expect(led.events.at(-1)).toMatchObject({ kind: 'edge', summary: 'LED on' })
  })

  it('ignores a write that does not change the level', () => {
    const led = harness(new LedModel())
    led.signal('ANODE', 0)
    led.signal('ANODE', 0)
    expect(led.snapshot()).toMatchObject({ edges: 0 })
    expect(led.events).toHaveLength(0)
  })

  it('counts every real edge across a blink', () => {
    const led = harness(new LedModel())
    for (let i = 0; i < 5; i++) led.pulse('ANODE')
    expect(led.snapshot()).toMatchObject({ edges: 10, lit: false })
    expect(led.meter('edges')).toBe(10)
  })

  it('reports a ~50% duty cycle for a symmetric square wave', () => {
    const led = harness(new LedModel(), { tick: 1_000_000 })
    // on for one tick, off for one tick, repeated.
    for (let i = 0; i < 10; i++) led.pulse('ANODE')
    expect(led.meter('duty')).toBeGreaterThan(45)
    expect(led.meter('duty')).toBeLessThan(55)
  })

  it('warns on an unknown signal name rather than acting on it', () => {
    const led = harness(new LedModel())
    led.signal('CATHODE', 1)
    expect(led.diagnostics.at(-1)).toMatchObject({ severity: 'warn' })
    expect(led.snapshot()).toMatchObject({ edges: 0 })
  })

  it('clears state on reset', () => {
    const led = harness(new LedModel())
    led.pulse('ANODE')
    led.reset()
    expect(led.snapshot()).toMatchObject({ lit: false, edges: 0 })
  })

  it('is registered under its declared id', () => {
    expect(ledDescriptor.id).toBe('pinbench.led')
    expect(ledDescriptor.create().id).toBe('pinbench.led')
  })
})
