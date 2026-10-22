import { describe, expect, it, vi } from 'vitest'
import { DeviceHarness, harness } from './harness'
import type {
  BusResponse,
  BusTransaction,
  DeviceContext,
  DeviceModel,
  MeterDeclaration,
  SignalEdge
} from './model'

/** A minimal model that records what the harness feeds it. */
class SpyModel implements DeviceModel {
  readonly id = 'test.spy'
  readonly meters: readonly MeterDeclaration[] = [{ id: 'calls', label: 'Calls' }]
  ctx: DeviceContext | null = null
  bus: BusTransaction[] = []
  signals: SignalEdge[] = []
  commands: { command: string; args?: Record<string, unknown> }[] = []
  attached = 0
  detached = 0

  attach(ctx: DeviceContext): void {
    this.ctx = ctx
    this.attached++
  }
  reset(): void {
    this.bus = []
    this.signals = []
  }
  detach(): void {
    this.detached++
  }
  onBus(txn: BusTransaction): BusResponse {
    this.bus.push(txn)
    this.ctx?.emit({ kind: 'tx', summary: `${txn.mosi.length} bytes` })
    return { miso: new Uint8Array(txn.mosi.length).fill(0xa5) }
  }
  onSignal(edge: SignalEdge): void {
    this.signals.push(edge)
    this.ctx?.driveSignal('IRQ', edge.level)
  }
  onCommand(command: string, args?: Record<string, unknown>): void {
    this.commands.push({ command, ...(args ? { args } : {}) })
  }
  snapshot(): Record<string, unknown> {
    return { bus: this.bus.length, signals: this.signals.length }
  }
  meter(id: string): number | undefined {
    return id === 'calls' ? this.bus.length + this.signals.length : undefined
  }
}

describe('DeviceHarness', () => {
  it('attaches the model on construction', () => {
    const model = new SpyModel()
    harness(model)
    expect(model.attached).toBe(1)
  })

  it('feeds a whole transaction and returns the MISO bytes', () => {
    const model = new SpyModel()
    const h = harness(model)
    const miso = h.bus({ bus: 'spi0', kind: 'spi', mosi: new Uint8Array([1, 2, 3]) })
    expect([...miso]).toEqual([0xa5, 0xa5, 0xa5])
    expect(model.bus[0]!.mosi).toHaveLength(3)
  })

  it('auto-advances the clock between un-timestamped actions', () => {
    const model = new SpyModel()
    const h = harness(model, { tick: 1000 })
    h.signal('X', 1)
    h.signal('X', 0)
    expect(model.signals.map((s) => s.t)).toEqual([1000, 2000])
  })

  it('honours an explicit timestamp', () => {
    const model = new SpyModel()
    const h = harness(model)
    h.bus({ bus: 'spi0', kind: 'spi', mosi: new Uint8Array(1), t: 42 })
    expect(model.bus[0]!.t).toBe(42)
  })

  it('records events, diagnostics and driven lines', () => {
    const model = new SpyModel()
    const h = harness(model)
    h.bus({ bus: 'spi0', kind: 'spi', mosi: new Uint8Array(2) })
    h.signal('KEY', 1)
    expect(h.events).toEqual([{ kind: 'tx', summary: '2 bytes', t: expect.any(Number) }])
    expect(h.driven).toEqual([{ signal: 'IRQ', level: 1 }])
    expect(h.line('IRQ')).toBe(1)
  })

  it('flags a model that returns the wrong number of bytes', () => {
    const bad: DeviceModel = {
      id: 'test.bad',
      meters: [],
      attach: () => undefined,
      reset: () => undefined,
      detach: () => undefined,
      onBus: () => ({ miso: new Uint8Array(1) }),
      snapshot: () => ({}),
      meter: () => undefined
    }
    const h = harness(bad)
    h.bus({ bus: 'spi0', kind: 'spi', mosi: new Uint8Array(4) })
    expect(h.diagnostics.at(-1)).toMatchObject({ severity: 'error' })
  })

  it('throws if a test drives a hook the model does not implement', () => {
    const noBus: DeviceModel = {
      id: 'test.nobus',
      meters: [],
      attach: () => undefined,
      reset: () => undefined,
      detach: () => undefined,
      snapshot: () => ({}),
      meter: () => undefined
    }
    expect(() => harness(noBus).bus({ bus: 'x', kind: 'spi', mosi: new Uint8Array(1) })).toThrow(
      /does not implement onBus/
    )
  })

  it('collects every declared meter in one call', () => {
    const h = harness(new SpyModel())
    h.signal('A', 1)
    expect(h.meters()).toEqual({ calls: 1 })
  })

  it('passes commands through with their args', () => {
    const model = new SpyModel()
    const h = harness(model)
    h.command('inject', { addr: 3 })
    expect(model.commands).toEqual([{ command: 'inject', args: { addr: 3 } }])
  })

  it('is exported as a class too', () => {
    expect(new DeviceHarness(new SpyModel())).toBeInstanceOf(DeviceHarness)
  })

  it('does not swallow a model that throws', () => {
    const model = new SpyModel()
    vi.spyOn(model, 'onSignal').mockImplementation(() => {
      throw new Error('boom')
    })
    expect(() => harness(model).signal('X', 1)).toThrow('boom')
  })
})
