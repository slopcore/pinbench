/**
 * "Verify pin map" (`⌘B`) — the rule engine behind the design's pin-check, as a
 * pure function over a {@link BoardDefinition}. No Electron, no DOM: the M4
 * harness pattern, so every rule lands with a test.
 *
 * Roadmap M11.1. The rules are the ones the milestone names:
 *
 *  - a GPIO bound to two signals (with a declared-exception list — the M9's
 *    `GPIO12` carries `KEY_INT` + `ESP32_WAKEUP` on purpose, per M8);
 *  - strapping pins (`GPIO0`/`3`/`45`/`46` — the `strapping` capability) in a
 *    peripheral role, which must idle safely at boot;
 *  - a signal on a pin whose `capabilities` cannot route its bus kind
 *    ("peripherals mapped to pins their silicon cannot route");
 *  - shared-bus chip-select: each SPI bus needs its selects on distinct pins,
 *    and a bus with parts but no select is suspicious.
 *
 * Findings map 1:1 onto {@link Diagnostic} rows for the dock; each carries an
 * optional `ref` so M11.3 can make the row click through to the part or pin.
 */

import type { BoardDefinition } from './board'
import type { Diagnostic, DiagnosticSeverity } from './diagnostics'

/** Signal names that legitimately share a pin across a bus (the bus wires). */
const SHARED_BUS_SIGNALS = new Set([
  'SCK',
  'SCLK',
  'CLK',
  'MOSI',
  'SDA',
  'MISO',
  'SDO',
  'SDI',
  'SCL',
  'TX',
  'RX',
  'TXD',
  'RXD'
])

/** Chip-select-like signal names on a shared SPI bus. */
const SELECT_SIGNALS = new Set(['CS', 'NSS', 'SS', 'CSB', 'SSN'])

/** Bus-kind → the pin capability a pin needs to carry it. */
const KIND_CAPABILITY: Record<string, string> = {
  spi: 'spi',
  i2c: 'i2c',
  uart: 'uart',
  onewire: 'gpio'
}

export interface VerifyFinding {
  severity: DiagnosticSeverity
  message: string
  /** Where the finding points — a part id, a pin id, a net id, or a bus id. */
  ref?: { kind: 'part' | 'pin' | 'net' | 'bus'; id: string }
}

/** Run every rule over `board` and return findings worst-first. */
export function verifyBoard(board: BoardDefinition): VerifyFinding[] {
  const findings: VerifyFinding[] = [
    ...doubleBindFindings(board),
    ...strappingFindings(board),
    ...routingFindings(board),
    ...chipSelectFindings(board)
  ]
  const rank: Record<DiagnosticSeverity, number> = { error: 0, warn: 1, note: 2, info: 3, ok: 4 }
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity])
}

/** Convert findings to dock rows. Stable ids so a re-run replaces, not appends. */
export function findingsToDiagnostics(findings: VerifyFinding[]): Diagnostic[] {
  return findings.map((f, i) => ({
    id: `verify-${i}-${f.ref?.kind ?? 'x'}-${f.ref?.id ?? ''}`,
    severity: f.severity,
    message: f.message
  }))
}

// --- rules -----------------------------------------------------------------

function doubleBindFindings(board: BoardDefinition): VerifyFinding[] {
  const exceptions = new Set(board.pinExceptions ?? [])
  const byPin = new Map<string, { partId: string; signal: string }[]>()
  for (const part of board.parts) {
    for (const binding of part.pins) {
      const list = byPin.get(binding.pin) ?? []
      list.push({ partId: part.id, signal: binding.signal })
      byPin.set(binding.pin, list)
    }
  }

  const out: VerifyFinding[] = []
  for (const [pin, bindings] of byPin) {
    if (bindings.length < 2) continue
    // All-bus-wire bindings on one pin are how a shared bus is drawn — fine.
    if (bindings.every((b) => SHARED_BUS_SIGNALS.has(b.signal.toUpperCase()))) continue

    const label = bindings.map((b) => `${b.partId}:${b.signal}`).join(' + ')
    if (exceptions.has(pin)) {
      out.push({
        severity: 'note',
        message: `${pin} carries ${label} — a declared intentional double-bind`,
        ref: { kind: 'pin', id: pin }
      })
    } else {
      out.push({
        severity: 'warn',
        message: `${pin} is bound to ${bindings.length} signals: ${label}`,
        ref: { kind: 'pin', id: pin }
      })
    }
  }
  return out
}

function strappingFindings(board: BoardDefinition): VerifyFinding[] {
  const strapping = new Set(
    board.pins.filter((p) => p.capabilities.includes('strapping')).map((p) => p.id)
  )
  const out: VerifyFinding[] = []
  for (const part of board.parts) {
    for (const binding of part.pins) {
      if (!strapping.has(binding.pin)) continue
      // A reset / boot line on a strapping pin is exactly what the pin is for.
      if (/RESET|RST|BOOT|NRESET/i.test(binding.signal)) continue
      out.push({
        severity: 'note',
        message: `${binding.pin} is a strapping pin driving ${part.id}:${binding.signal} — confirm it idles to the boot-safe level`,
        ref: { kind: 'pin', id: binding.pin }
      })
    }
  }
  return out
}

function routingFindings(board: BoardDefinition): VerifyFinding[] {
  const pinCaps = new Map<string, Set<string>>(
    board.pins.map((p) => [p.id, new Set<string>(p.capabilities)])
  )
  const busKind = new Map(board.buses.map((b) => [b.id, b.kind]))
  const out: VerifyFinding[] = []

  for (const part of board.parts) {
    for (const busId of part.buses) {
      const kind = busKind.get(busId)
      if (!kind) continue
      const needed = KIND_CAPABILITY[kind]
      if (!needed) continue
      for (const binding of part.pins) {
        const caps = pinCaps.get(binding.pin)
        // Only flag bus-carrying signals; a part's discrete GPIOs (RST, IRQ)
        // are not on the bus and only need `gpio`.
        const onBus =
          SHARED_BUS_SIGNALS.has(binding.signal.toUpperCase()) ||
          SELECT_SIGNALS.has(binding.signal.toUpperCase())
        if (!onBus) continue
        if (caps && !caps.has(needed)) {
          out.push({
            severity: 'warn',
            message: `${part.id}:${binding.signal} needs ${kind.toUpperCase()} routing but ${binding.pin} has no ${needed} capability`,
            ref: { kind: 'pin', id: binding.pin }
          })
        }
      }
    }
  }
  return out
}

function chipSelectFindings(board: BoardDefinition): VerifyFinding[] {
  const out: VerifyFinding[] = []
  for (const bus of board.buses) {
    if (bus.kind !== 'spi') continue
    const parts = board.parts.filter((p) => p.buses.includes(bus.id))
    if (parts.length === 0) continue

    const selects: { partId: string; signal: string; pin: string }[] = []
    for (const part of parts) {
      for (const binding of part.pins) {
        if (SELECT_SIGNALS.has(binding.signal.toUpperCase())) {
          selects.push({ partId: part.id, signal: binding.signal, pin: binding.pin })
        }
      }
    }

    const byPin = new Map<string, typeof selects>()
    for (const s of selects) {
      const list = byPin.get(s.pin) ?? []
      list.push(s)
      byPin.set(s.pin, list)
    }
    let clean = true
    for (const [pin, group] of byPin) {
      if (group.length > 1) {
        clean = false
        out.push({
          severity: 'warn',
          message: `${bus.label}: chip-selects ${group
            .map((s) => `${s.partId}:${s.signal}`)
            .join(' and ')} share ${pin} — asserting the bus selects two devices at once`,
          ref: { kind: 'bus', id: bus.id }
        })
      }
    }
    if (selects.length < parts.filter((p) => p.category !== 'mcu').length) {
      clean = false
      out.push({
        severity: 'info',
        message: `${bus.label}: ${parts.length} parts but only ${selects.length} chip-select${selects.length === 1 ? '' : 's'} — a device with no select is always addressed`,
        ref: { kind: 'bus', id: bus.id }
      })
    }
    if (clean) {
      out.push({
        severity: 'ok',
        message: `${bus.label}: ${selects.length} chip-selects, each on its own pin`,
        ref: { kind: 'bus', id: bus.id }
      })
    }
  }
  return out
}
