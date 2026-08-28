import { describe, expect, it } from 'vitest'
import { DeviceRegistry, deviceRegistry } from './registry'
import { LedModel } from './led'
import type { DeviceModelDescriptor } from './model'

const stub: DeviceModelDescriptor = {
  id: 'test.stub',
  summary: 'nothing',
  create: () => new LedModel()
}

describe('DeviceRegistry', () => {
  it('creates a registered model by id', () => {
    const registry = new DeviceRegistry()
    registry.register(stub)
    expect(registry.create('test.stub')).toBeInstanceOf(LedModel)
  })

  it('returns undefined for an unknown id rather than throwing', () => {
    const registry = new DeviceRegistry()
    expect(registry.create('semtech.lr1110')).toBeUndefined()
    expect(registry.has('semtech.lr1110')).toBe(false)
  })

  it('rejects a duplicate registration — that is a real bug', () => {
    const registry = new DeviceRegistry()
    registry.register(stub)
    expect(() => registry.register(stub)).toThrow(/already registered/)
  })

  it('hands out a fresh instance each call', () => {
    const registry = new DeviceRegistry()
    registry.register(stub)
    expect(registry.create('test.stub')).not.toBe(registry.create('test.stub'))
  })
})

describe('the process registry', () => {
  it('has the built-in LED loaded', () => {
    expect(deviceRegistry.has('pinbench.led')).toBe(true)
    expect(deviceRegistry.ids()).toContain('pinbench.led')
  })
})
