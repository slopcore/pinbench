/**
 * The device-model interface every PinBench peripheral is written against.
 *
 * ADR 0001 decided device models are TypeScript modules hosted in the PinBench
 * process, reached over a batching socket. This file is the "transaction-shaped
 * from the first line of code" obligation that ADR left to M4: a model is
 * handed a whole bus transaction — never a byte — because a per-byte interface
 * makes an ST7789 frame flush take 7.7 seconds (ADR 0001, §Measurements).
 *
 * A model implements only the hooks for the seams its part actually has: the
 * LED sits on a GPIO and implements `onSignal` only; the LR1110 sits on SPI and
 * implements `onBus` and `onSignal`; a purely computed part may implement
 * neither and just answer `snapshot()`.
 *
 * Nothing here imports Electron, Node or the DOM — the M4 test harness drives a
 * model with plain objects and no emulator in the loop.
 */

import type { BusKind } from '@shared/board'

/**
 * One whole bus transaction, handed to a model in a single call.
 *
 * For SPI this is everything clocked between one chip-select assertion and its
 * release. For I2C it is one START…STOP. `mosi` is the bytes the guest sent;
 * the model returns the same number of bytes back (see {@link BusResponse}).
 */
export interface BusTransaction {
  /** Board bus id, e.g. `spi0` — matches `BusDefinition.id`. */
  bus: string
  kind: BusKind
  /**
   * Which peer the controller addressed: the asserted chip-select signal name
   * for SPI (`'NSS'`, `'CS'`), or the 7-bit address for I2C. Omitted on a bus
   * with a single implicit peer, such as a dedicated UART.
   */
  select?: string | number
  /** Bytes the guest clocked out to the device. Never empty. */
  mosi: Uint8Array
  /** Nanoseconds since emulator start — for airtime and timing models. */
  t: number
}

/**
 * A model's reply to a transaction. `miso.length` must equal the
 * transaction's `mosi.length`; the host pads or truncates and raises a
 * diagnostic if it does not, rather than letting a length bug reach the guest
 * silently.
 */
export interface BusResponse {
  miso: Uint8Array
}

/** A digital line into the device changing level — its GPIO, a reset, a strobe. */
export interface SignalEdge {
  /** The device's own signal name, e.g. `ANODE`, `RST`, `KEY_INT`. */
  signal: string
  level: 0 | 1
  /** Nanoseconds since emulator start. */
  t: number
}

export type DeviceDiagnosticSeverity = 'error' | 'warn' | 'info'

/** A row for the device's OUT-panel event log. */
export interface DeviceEvent {
  /** Monotonic ns; the host stamps it from the last transaction if omitted. */
  t?: number
  /** Short machine-ish tag, e.g. `edge`, `tx`, `rx`, `cmd`. */
  kind: string
  /** One-line human summary shown in the log. */
  summary: string
  /** Optional structured detail rendered under the summary. */
  detail?: Record<string, string | number | boolean>
}

/**
 * A value the model publishes to its OUT-panel meter row. Declared once and
 * fixed for the life of the model so the renderer can lay the row out ahead of
 * any data.
 */
export interface MeterDeclaration {
  id: string
  label: string
  /** e.g. `Hz`, `dBm`, `%`, `ms`. Omit for a bare count. */
  unit?: string
}

/**
 * The model's observable state, structured-clonable, sent to the renderer on
 * every change. Device-defined shape; the OUT panel renders it generically and
 * a few models (the LED) get bespoke rendering keyed off their model id.
 */
export type DeviceSnapshot = Record<string, unknown>

/**
 * The capabilities the host lends a model for the duration of `attach`. A model
 * keeps the reference and calls back into it whenever it needs to drive a line
 * out, log an event, or complain.
 */
export interface DeviceContext {
  /** Drive one of the device's output lines (IRQ, BUSY, PPS, …). */
  driveSignal(signal: string, level: 0 | 1): void
  /** Append a row to the device's OUT-panel event log. */
  emit(event: DeviceEvent): void
  /**
   * Raise a diagnostic — an unimplemented command, a protocol violation, a
   * value out of range. M7's rule, the radio ("make unimplemented commands raise a loud,
   * named diagnostic rather than silently returning zeros") is the standard
   * every model is held to; this is how they do it.
   */
  diagnose(severity: DeviceDiagnosticSeverity, message: string): void
}

/**
 * The contract. A registered factory returns one of these per instance; the
 * host owns its lifecycle.
 */
export interface DeviceModel {
  /** Model id, matching `PartDefinition.deviceModel`, e.g. `pinbench.led`. */
  readonly id: string
  /** Meters this model publishes. Fixed for the life of the instance. */
  readonly meters: readonly MeterDeclaration[]

  /** Called once when the board loads. The context is valid until `detach`. */
  attach(ctx: DeviceContext): void
  /** Return to power-on state. May be called any time after `attach`. */
  reset(): void
  /** Called when the board unloads — release timers and handles here. */
  detach(): void

  /**
   * Handle one whole bus transaction and return the same number of bytes.
   * Omitted by a model that does not sit on a bus.
   */
  onBus?(txn: BusTransaction): BusResponse

  /** A line into the device changed level. Omitted if the device has none. */
  onSignal?(edge: SignalEdge): void

  /**
   * A command from the device's IN panel. Free-form per model; M7 onward wires
   * the panels. Omitted by a model with no inputs.
   */
  onCommand?(command: string, args?: Record<string, unknown>): void

  /** Current observable state for the renderer. Must be structured-clonable. */
  snapshot(): DeviceSnapshot
  /** Current value of a declared meter, or `undefined` if unknown yet. */
  meter(id: string): number | undefined
}

/**
 * A model constructor, as held by the registry. `options` are the fixed
 * board-hardware options from `PartDefinition.deviceOptions` (or `undefined`);
 * each model validates the shape it cares about.
 */
export type DeviceModelFactory = (options?: Record<string, unknown>) => DeviceModel

/** A built-in model's registry entry. */
export interface DeviceModelDescriptor {
  id: string
  /** One line for `docs/devices/authoring.md` and the Library later. */
  summary: string
  create: DeviceModelFactory
}
