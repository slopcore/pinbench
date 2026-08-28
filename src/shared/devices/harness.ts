/**
 * The device-model test harness.
 *
 * The roadmap calls this "the single highest-leverage thing in the project":
 * exercise a model against scripted bus transactions and signal edges with no
 * QEMU and no Electron in the loop, so every future device milestone lands
 * with tests because the harness makes that the path of least resistance.
 *
 * It builds the {@link DeviceContext} the host would give the model, records
 * everything the model sends back out (events, diagnostics, driven lines), and
 * hands you terse methods to drive it. `t` auto-advances if you do not supply
 * one, so a test reads as a sequence of actions rather than a column of
 * timestamps.
 */

import type {
  BusTransaction,
  DeviceContext,
  DeviceDiagnosticSeverity,
  DeviceEvent,
  DeviceModel,
  DeviceSnapshot
} from './model'

export interface RecordedDiagnostic {
  severity: DeviceDiagnosticSeverity
  message: string
}

export interface RecordedSignal {
  signal: string
  level: 0 | 1
}

export interface HarnessOptions {
  /** ns added to the clock between un-timestamped actions. Default 1_000_000. */
  tick?: number
  /** ns the clock starts at. Default 0. */
  startT?: number
}

export class DeviceHarness {
  readonly events: DeviceEvent[] = []
  readonly diagnostics: RecordedDiagnostic[] = []
  /** Lines the model drove out, in order. */
  readonly driven: RecordedSignal[] = []

  private readonly model: DeviceModel
  private readonly tick: number
  private clock: number
  /** The model's most recent view of each line it drives. */
  private readonly lineState = new Map<string, 0 | 1>()

  constructor(model: DeviceModel, options: HarnessOptions = {}) {
    this.model = model
    this.tick = options.tick ?? 1_000_000
    this.clock = options.startT ?? 0

    const ctx: DeviceContext = {
      driveSignal: (signal, level) => {
        this.lineState.set(signal, level)
        this.driven.push({ signal, level })
      },
      emit: (event) => {
        this.events.push({ ...event, t: event.t ?? this.clock })
      },
      diagnose: (severity, message) => {
        this.diagnostics.push({ severity, message })
      }
    }
    this.model.attach(ctx)
  }

  /** Current line level the model last drove, or `undefined` if it never has. */
  line(signal: string): 0 | 1 | undefined {
    return this.lineState.get(signal)
  }

  private advance(t?: number): number {
    if (t !== undefined) {
      this.clock = t
      return t
    }
    this.clock += this.tick
    return this.clock
  }

  /** Send one whole bus transaction; returns the model's `miso` bytes. */
  bus(txn: Omit<BusTransaction, 't'> & { t?: number }): Uint8Array {
    if (!this.model.onBus) {
      throw new Error(`${this.model.id} does not implement onBus`)
    }
    const t = this.advance(txn.t)
    const response = this.model.onBus({ ...txn, t })
    if (response.miso.length !== txn.mosi.length) {
      this.diagnostics.push({
        severity: 'error',
        message: `onBus returned ${response.miso.length} bytes for a ${txn.mosi.length}-byte transaction`
      })
    }
    return response.miso
  }

  /** Drive a line into the device to `level`. */
  signal(signal: string, level: 0 | 1, t?: number): void {
    if (!this.model.onSignal) {
      throw new Error(`${this.model.id} does not implement onSignal`)
    }
    this.model.onSignal({ signal, level, t: this.advance(t) })
  }

  /** Convenience: a low→high→low pulse on a line. */
  pulse(signal: string, t?: number): void {
    this.signal(signal, 1, t)
    this.signal(signal, 0)
  }

  command(command: string, args?: Record<string, unknown>): void {
    if (!this.model.onCommand) {
      throw new Error(`${this.model.id} does not implement onCommand`)
    }
    this.model.onCommand(command, args)
  }

  reset(): void {
    this.model.reset()
  }

  detach(): void {
    this.model.detach()
  }

  snapshot(): DeviceSnapshot {
    return this.model.snapshot()
  }

  meter(id: string): number | undefined {
    return this.model.meter(id)
  }

  /** All declared meters and their current values — handy for one assertion. */
  meters(): Record<string, number | undefined> {
    const out: Record<string, number | undefined> = {}
    for (const declaration of this.model.meters) {
      out[declaration.id] = this.model.meter(declaration.id)
    }
    return out
  }
}

/** Sugar for `new DeviceHarness(model, options)`. */
export function harness(model: DeviceModel, options?: HarnessOptions): DeviceHarness {
  return new DeviceHarness(model, options)
}
