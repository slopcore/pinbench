/**
 * An LED on a GPIO — PinBench's first device model.
 *
 * Deliberately the smallest thing that exercises the whole path: a signal edge
 * in, observable state out, a meter, an event log. If firmware toggling a GPIO
 * does not make this blink in its OUT panel, the plumbing from the guest's
 * `GPIO_OUT` write to the renderer is broken somewhere — which is exactly why
 * the roadmap picked it.
 *
 * The model is polarity-aware (`activeHigh`) because the M9's real indicators
 * are a mix, and because it costs one line to get right now versus a migration
 * later.
 */

import type {
  DeviceContext,
  DeviceEvent,
  DeviceModel,
  DeviceModelDescriptor,
  DeviceSnapshot,
  MeterDeclaration,
  SignalEdge
} from './model'

/** The line the emulated GPIO net drives. */
const ANODE = 'ANODE'

export interface LedOptions {
  /** True: lit when the pin is high. False: lit when the pin is low. */
  activeHigh?: boolean
}

interface LedState {
  /** Raw pin level, before polarity. */
  pin: 0 | 1
  /** Whether the LED is emitting light, after polarity. */
  lit: boolean
  /** Total edges seen since the last reset. */
  edges: number
  /** ns at the last edge. */
  lastEdgeT: number
  /** ns-weighted time the LED has spent lit, for the duty-cycle meter. */
  litNs: number
  /** ns at which the current `lit` window began. */
  windowStartT: number
}

export class LedModel implements DeviceModel {
  readonly id = 'pinbench.led'
  readonly meters: readonly MeterDeclaration[] = [
    { id: 'duty', label: 'Duty cycle', unit: '%' },
    { id: 'edges', label: 'Edges' }
  ]

  private readonly activeHigh: boolean
  private ctx: DeviceContext | null = null
  private state: LedState = LedModel.blank()

  constructor(options: LedOptions = {}) {
    this.activeHigh = options.activeHigh ?? true
  }

  private static blank(): LedState {
    return {
      pin: 0,
      lit: false,
      edges: 0,
      lastEdgeT: 0,
      litNs: 0,
      windowStartT: 0
    }
  }

  attach(ctx: DeviceContext): void {
    this.ctx = ctx
    this.state = LedModel.blank()
    // An active-low LED is lit at power-on, when the pin floats low.
    this.state.lit = !this.activeHigh
  }

  reset(): void {
    this.state = LedModel.blank()
    this.state.lit = !this.activeHigh
  }

  detach(): void {
    this.ctx = null
  }

  onSignal(edge: SignalEdge): void {
    if (edge.signal !== ANODE) {
      this.ctx?.diagnose('warn', `LED has no signal "${edge.signal}" (expected ${ANODE})`)
      return
    }
    if (edge.level === this.state.pin) return // not an edge

    // Close the current duty window before flipping.
    if (this.state.lit) this.state.litNs += edge.t - this.state.windowStartT

    this.state.pin = edge.level
    this.state.lit = this.activeHigh ? edge.level === 1 : edge.level === 0
    this.state.windowStartT = edge.t
    this.state.lastEdgeT = edge.t
    this.state.edges += 1

    const event: DeviceEvent = {
      t: edge.t,
      kind: 'edge',
      summary: this.state.lit ? 'LED on' : 'LED off',
      detail: { pin: edge.level, edges: this.state.edges }
    }
    this.ctx?.emit(event)
  }

  snapshot(): DeviceSnapshot {
    return {
      lit: this.state.lit,
      pin: this.state.pin,
      activeHigh: this.activeHigh,
      edges: this.state.edges,
      lastEdgeT: this.state.lastEdgeT
    }
  }

  meter(id: string): number | undefined {
    if (id === 'edges') return this.state.edges
    if (id === 'duty') {
      const now = Math.max(this.state.lastEdgeT, this.state.windowStartT)
      const litNs = this.state.litNs + (this.state.lit ? now - this.state.windowStartT : 0)
      if (now <= 0) return this.state.lit ? 100 : 0
      return Math.round((litNs / now) * 1000) / 10
    }
    return undefined
  }
}

export const ledDescriptor: DeviceModelDescriptor = {
  id: 'pinbench.led',
  summary: 'An LED on a GPIO. Active-high by default; tracks edges and duty cycle.',
  create: () => new LedModel()
}
