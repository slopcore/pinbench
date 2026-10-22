/**
 * Keyboard coprocessor device model (Elecrow ThinkNode M9).
 *
 * Emulates the onboard ESP32-S2 / keypad coprocessor:
 * - Listens to IN-panel key commands ('UP', 'DOWN', 'LEFT', 'RIGHT', 'OK', 'ENTER', etc.)
 * - Buffers key events in an internal queue
 * - Pulses the active-low KEY_INT (GPIO12) interrupt line
 * - Exposes key count meters and snapshot state
 */

import type {
  DeviceContext,
  DeviceEvent,
  DeviceModel,
  DeviceModelDescriptor,
  DeviceSnapshot,
  MeterDeclaration
} from './model'

export interface KbdCoprocessorOptions {
  /** Interrupt signal name. Default 'KEY_INT'. */
  intSignal?: string
  /** How long KEY_INT is held low after a key, in ms. Default 1000. */
  pulseMs?: number
}

interface KbdCoprocessorState {
  lastKey: string
  keyCount: number
  buffer: string
  queue: string[]
}

function toKeyCode(key: string): number {
  const upper = key.toUpperCase()
  switch (upper) {
    case 'UP': return 0x81
    case 'DOWN': return 0x82
    case 'LEFT': return 0x83
    case 'RIGHT': return 0x84
    case 'ENTER':
    case 'OK': return 0x85
    case 'BACK':
    case 'ESC': return 0x86
    case 'HOME': return 0x87
    case 'MSG':
    case 'INBOX': return 0x89
    case 'MAP': return 0x8a
    case 'LOC':
    case 'GPS': return 0x8b
    case 'CHAT': return 0x8c
    case 'BKSP': return 0x08
    case 'TAB': return 0x09
    case 'SPACE': return 0x20
    default:
      return key.length === 1 ? key.charCodeAt(0) : 0
  }
}

export class KbdCoprocessorModel implements DeviceModel {
  readonly id = 'pinbench.kbd-coprocessor'
  readonly meters: readonly MeterDeclaration[] = [
    { id: 'keys', label: 'Keys pressed' },
    { id: 'queue', label: 'Queue depth' }
  ]
  readonly outputSignals: readonly string[] = ['KEY_INT', 'SDA']

  private readonly intSignal: string
  private readonly pulseMs: number
  private ctx: DeviceContext | null = null
  private state: KbdCoprocessorState
  private intTimer: ReturnType<typeof setTimeout> | null = null
  private currentCode = 0
  private bitIndex = 0

  constructor(options: KbdCoprocessorOptions = {}) {
    this.intSignal = options.intSignal ?? 'KEY_INT'
    this.pulseMs = options.pulseMs ?? 1000
    this.state = this.blank()
  }

  private blank(): KbdCoprocessorState {
    return {
      lastKey: '',
      keyCount: 0,
      buffer: '',
      queue: []
    }
  }

  attach(ctx: DeviceContext): void {
    this.ctx = ctx
    this.state = this.blank()
    this.currentCode = 0
    this.bitIndex = 0
    // KEY_INT is active-low with internal pullup; idles high (1)
    this.ctx.driveSignal(this.intSignal, 1)
    this.ctx.driveSignal('SDA', 1)
  }

  reset(): void {
    this.clearTimer()
    this.state = this.blank()
    this.currentCode = 0
    this.bitIndex = 0
    this.ctx?.driveSignal(this.intSignal, 1)
    this.ctx?.driveSignal('SDA', 1)
  }

  detach(): void {
    this.clearTimer()
    this.ctx = null
  }

  onSignal(edge: { signal: string; level: 0 | 1; t?: number }): void {
    if (edge.signal === 'SCL' && edge.level === 1 && this.currentCode !== 0) {
      this.bitIndex++
      if (this.bitIndex < 8) {
        const nextBit = ((this.currentCode >> this.bitIndex) & 1) as 0 | 1
        this.ctx?.driveSignal('SDA', nextBit)
      } else {
        this.ctx?.driveSignal(this.intSignal, 1)
        this.ctx?.driveSignal('SDA', 1)
        this.currentCode = 0
        this.bitIndex = 0
      }
    }
  }

  onCommand(command: string, args?: Record<string, unknown>): void {
    if (command === 'key' || command === 'press') {
      const key = String(args?.['key'] ?? args?.['code'] ?? '')
      if (!key) return

      this.state.lastKey = key
      this.state.keyCount += 1
      this.state.queue.push(key)
      if (this.state.queue.length > 32) this.state.queue.shift()

      // Update text buffer preview
      const nextBuf =
        key === 'BKSP'
          ? this.state.buffer.slice(0, -1)
          : key === 'SPACE'
            ? `${this.state.buffer} `
            : key === 'ENTER' || key === 'OK'
              ? `${this.state.buffer}⏎`
              : key.length === 1
                ? this.state.buffer + key
                : this.state.buffer
      this.state.buffer = nextBuf.slice(-32)

      const event: DeviceEvent = {
        t: Date.now(),
        kind: 'key',
        summary: `Key pressed: ${key}`,
        detail: { key, count: this.state.keyCount }
      }
      this.ctx?.emit(event)

      this.currentCode = toKeyCode(key)
      this.bitIndex = 0

      // Drive bit 0 on SDA and assert KEY_INT low
      this.ctx?.driveSignal('SDA', (this.currentCode & 1) as 0 | 1)
      this.ctx?.driveSignal(this.intSignal, 0)

      this.clearTimer()
      this.intTimer = setTimeout(() => {
        this.intTimer = null
        this.ctx?.driveSignal(this.intSignal, 1)
        this.ctx?.driveSignal('SDA', 1)
        this.currentCode = 0
      }, this.pulseMs)
      if (this.intTimer && typeof this.intTimer.unref === 'function') {
        this.intTimer.unref()
      }
    } else {
      this.ctx?.diagnose('warn', `kbd-coprocessor: unrecognized command "${command}"`)
    }
  }

  private clearTimer(): void {
    if (this.intTimer) {
      clearTimeout(this.intTimer)
      this.intTimer = null
    }
  }

  snapshot(): DeviceSnapshot {
    return {
      lastKey: this.state.lastKey,
      keyCount: this.state.keyCount,
      buffer: this.state.buffer,
      queueDepth: this.state.queue.length
    }
  }

  meter(id: string): number | undefined {
    if (id === 'keys') return this.state.keyCount
    if (id === 'queue') return this.state.queue.length
    return undefined
  }
}

export const kbdCoprocessorDescriptor: DeviceModelDescriptor = {
  id: 'pinbench.kbd-coprocessor',
  summary:
    'ThinkNode M9 Keyboard coprocessor matrix over I2C, KEY_INT interrupt on GPIO12.',
  create: (options) => new KbdCoprocessorModel(options as KbdCoprocessorOptions)
}
