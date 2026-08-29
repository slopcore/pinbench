/**
 * Pin-map codegen (roadmap M11.2). The board definition — the canvas's data
 * model — emits the firmware's pin header and the `build_flags` that carry the
 * same numbers, so "edit the canvas, not this file" is literally true.
 *
 * Pure, no Electron/DOM (the M4 harness pattern). The main process writes the
 * output on Build & flash and uses {@link headerFingerprint} for the
 * round-trip guard the milestone's watch-for demands: never silently
 * overwrite a header a human has hand-edited.
 */

import type { BoardDefinition } from './board'

/** First line of every generated header — also the divergence-guard anchor. */
export const HEADER_SENTINEL = '/* PinBench-generated pin map — DO NOT EDIT. Edit the canvas. */'

/** `"GPIO16"` → `16`; anything else → `null`. */
function pinNumber(pin: string): number | null {
  const m = /(\d+)$/.exec(pin)
  return m ? Number(m[1]) : null
}

/** Uppercase, non-alnum → `_`, collapse repeats, trim — a safe C identifier. */
function ident(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
}

interface Define {
  name: string
  value: number
  /** Where it came from, for the trailing comment. */
  origin: string
}

/**
 * The `#define` set: one per net that lands on a single GPIO (using the net
 * label), one per bus role (`<BUS>_<ROLE>`), and one per part pin binding
 * (`<DESIGNATOR>_<SIGNAL>_PIN`). De-duplicated by name; the first origin wins.
 */
export function pinDefines(
  board: BoardDefinition
): { name: string; value: number; origin: string }[] {
  const out: Define[] = []
  const seen = new Set<string>()
  const add = (name: string, value: number, origin: string): void => {
    if (seen.has(name)) return
    seen.add(name)
    out.push({ name, value, origin })
  }

  for (const net of board.nets) {
    const gpios = net.nodes.filter((n) => pinNumber(n) !== null)
    if (gpios.length === 1) add(ident(net.label), pinNumber(gpios[0]!)!, `net ${net.id}`)
  }

  for (const bus of board.buses) {
    for (const [role, pin] of Object.entries(bus.signals)) {
      const n = pinNumber(pin)
      if (n !== null) add(`${ident(bus.id)}_${ident(role)}`, n, `bus ${bus.id}`)
    }
  }

  for (const part of board.parts) {
    for (const binding of part.pins) {
      const n = pinNumber(binding.pin)
      if (n !== null) {
        add(
          `${ident(part.designator)}_${ident(binding.signal)}_PIN`,
          n,
          `${part.id}:${binding.signal}`
        )
      }
    }
  }

  return out
}

/** The full C header text. Deterministic — sorted by name for a stable diff. */
export function generatePinHeader(board: BoardDefinition): string {
  const defines = pinDefines(board).sort((a, b) => a.name.localeCompare(b.name))
  const guard = `PINBENCH_${ident(board.id)}_PINS_H`
  const width = Math.max(0, ...defines.map((d) => d.name.length))

  const lines = [
    HEADER_SENTINEL,
    `/* Board: ${board.name} (${board.id}) — ${board.mcu} */`,
    `#ifndef ${guard}`,
    `#define ${guard}`,
    ''
  ]
  for (const d of defines) {
    lines.push(`#define ${d.name.padEnd(width)} ${String(d.value).padStart(2)}  /* ${d.origin} */`)
  }
  lines.push('', `#endif /* ${guard} */`, '')
  return lines.join('\n')
}

/**
 * The `build_flags` lines carrying the same numbers, for firmware that reads
 * pins from `-D` rather than a header. Same set as {@link pinDefines}.
 */
export function generateBuildFlags(board: BoardDefinition): string[] {
  return pinDefines(board)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => `-D ${d.name}=${d.value}`)
}

/**
 * A stable fingerprint of the *semantic* content of a generated header — the
 * `NAME=value` pairs, order-independent, comments and spacing ignored. The
 * round-trip guard stores this after a write and compares it to the on-disk
 * file before the next write: a mismatch means a human edited the file, so ask
 * rather than clobber.
 */
export function headerFingerprint(headerText: string): string {
  const pairs: string[] = []
  for (const line of headerText.split(/\r?\n/)) {
    const m = /^#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(-?\d+)/.exec(line.trim())
    if (m) pairs.push(`${m[1]}=${m[2]}`)
  }
  pairs.sort()
  // FNV-1a over the canonical pair list → 8 hex chars. No crypto dependency.
  let hash = 0x811c9dc5
  for (const ch of pairs.join(';')) {
    hash ^= ch.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export interface DivergenceCheck {
  /** True when the on-disk file no longer matches what PinBench last generated. */
  diverged: boolean
  /** True when the file was never PinBench-generated (no sentinel) — treat as diverged. */
  foreign: boolean
}

/**
 * Compare an on-disk header against the fingerprint PinBench recorded at its
 * last write. `null`/empty `onDisk` is "no file yet" — not a divergence.
 */
export function checkHeaderDivergence(
  onDisk: string | null | undefined,
  lastFingerprint: string | null | undefined
): DivergenceCheck {
  if (!onDisk || onDisk.trim() === '') return { diverged: false, foreign: false }
  const foreign = !onDisk.includes(HEADER_SENTINEL)
  if (foreign) return { diverged: true, foreign: true }
  if (!lastFingerprint) return { diverged: false, foreign: false }
  return { diverged: headerFingerprint(onDisk) !== lastFingerprint, foreign: false }
}
