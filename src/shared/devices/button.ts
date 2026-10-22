/**
 * Momentary button on a GPIO (roadmap / Heltec SW1).
 *
 * Emulates a push-to-make button wired to a SoC input pin. Active-low with
 * internal pullup by default:
 *   - Idle / released: line driven HIGH (1)
 *   - Pressed: line driven LOW (0)
 *
 * Responds to IN-panel stimulus commands (`press` with optional `down` or `holdMs`,
 * `click`, `setParam`) and drives output signals so guest `GPIO_IN` reads
 * (`Op.GpioRead`) reflect the real button state.
 */

import type {
  DeviceContext,
  DeviceEvent,
  DeviceModel,
  DeviceModelDescriptor,
  DeviceSnapshot,
  MeterDeclaration
} from './model'

export interface ButtonOptions {
  /** True: active-low (idle high 1, pressed low 0). False: active-high. Default true. */
  activeLow?: boolean
  /** Primary signal name to drive. Default 'BTN'. */
  signal?: string
}

interface ButtonState {
  pressed: boolean
  presses: number
  pin: 0 | 1
  lastPressT: number
}

export class ButtonModel implements DeviceModel {
  readonly id = 'pinbench.button'
  readonly meters: readonly MeterDeclaration[] = [
    { id: 'presses', label: 'Presses' },
    { id: 'state', label: 'State' }
  ]
  readonly outputSignals: readonly string[]

  private readonly activeLow: boolean
  private readonly signalName: string
  private ctx: DeviceContext | null = null
  private state: ButtonState
  private holdTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: ButtonOptions = {}) {
    this.activeLow = options.activeLow ?? true
    this.signalName = options.signal ?? 'BTN'
    this.outputSignals = [this.signalName]
    this.state = this.blank()
  }

  private blank(): ButtonState {
    return {
      pressed: false,
      presses: 0,
      pin: this.activeLow ? 1 : 0,
      lastPressT: 0
    }
  }

  attach(ctx: DeviceContext): void {
    this.ctx = ctx
    this.state = this.blank()
    this.drive()
  }

  reset(): void {
    this.clearTimer()
    this.state = this.blank()
    this.drive()
  }

  detach(): void {
    this.clearTimer()
    this.ctx = null
  }

  onCommand(command: string, args?: Record<string, unknown>): void {
    if (command === 'press') {
      if (typeof args?.['holdMs'] === 'number') {
        const holdMs = args['holdMs']
        this.setPressed(true)
        this.clearTimer()
        this.holdTimer = setTimeout(() => {
          this.holdTimer = null
          this.setPressed(false)
        }, holdMs)
        if (this.holdTimer && typeof this.holdTimer.unref === 'function') {
          this.holdTimer.unref()
        }
      } else if (args?.['down'] !== undefined) {
        this.clearTimer()
        this.setPressed(Boolean(args['down']))
      } else {
        this.clearTimer()
        this.setPressed(!this.state.pressed)
      }
    } else if (command === 'click') {
      const holdMs = typeof args?.['holdMs'] === 'number' ? args['holdMs'] : 100
      this.setPressed(true)
      this.clearTimer()
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null
        this.setPressed(false)
      }, holdMs)
      if (this.holdTimer && typeof this.holdTimer.unref === 'function') {
        this.holdTimer.unref()
      }
    } else if (command === 'setParam' && args?.['pressed'] !== undefined) {
      this.clearTimer()
      this.setPressed(Boolean(args['pressed']))
    } else {
      this.ctx?.diagnose('warn', `button: unrecognized command "${command}"`)
    }
  }

  private setPressed(pressed: boolean): void {
    if (this.state.pressed === pressed) return
    this.state.pressed = pressed
    if (pressed) {
      this.state.presses += 1
      this.state.lastPressT = Date.now()
    }
    this.state.pin = (pressed ? (this.activeLow ? 0 : 1) : this.activeLow ? 1 : 0) as 0 | 1
    this.drive()

    const event: DeviceEvent = {
      t: this.state.lastPressT,
      kind: 'press',
      summary: pressed ? 'Button pressed (down)' : 'Button released (up)',
      detail: { pressed, pin: this.state.pin, presses: this.state.presses }
    }
    this.ctx?.emit(event)
  }

  private drive(): void {
    this.ctx?.driveSignal(this.signalName, this.state.pin)
  }

  private clearTimer(): void {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer)
      this.holdTimer = null
    }
  }

  snapshot(): DeviceSnapshot {
    return {
      pressed: this.state.pressed,
      pin: this.state.pin,
      activeLow: this.activeLow,
      presses: this.state.presses,
      lastPressT: this.state.lastPressT
    }
  }

  meter(id: string): number | undefined {
    if (id === 'presses') return this.state.presses
    if (id === 'state') return this.state.pressed ? 1 : 0
    return undefined
  }
}

export const buttonDescriptor: DeviceModelDescriptor = {
  id: 'pinbench.button',
  summary:
    'Momentary button on a GPIO. Active-low with pullup by default; tracks presses and state.',
  create: (options) => new ButtonModel(options as ButtonOptions)
}
