// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBoard, type BoardDefinition } from './board'
import { findingsToDiagnostics, verifyBoard } from './verify'

function m9(): BoardDefinition {
  return parseBoard(
    JSON.parse(
      readFileSync(resolve(__dirname, '../../boards/thinknode-m9-v1.0.board.json'), 'utf8')
    )
  )
}

/** Rebind one part's signal to a different pin, returning a fresh board. */
function rebind(
  board: BoardDefinition,
  partId: string,
  signal: string,
  pin: string
): BoardDefinition {
  return {
    ...board,
    parts: board.parts.map((p) =>
      p.id !== partId
        ? p
        : { ...p, pins: p.pins.map((b) => (b.signal === signal ? { ...b, pin } : b)) }
    )
  }
}

describe('verifyBoard', () => {
  it('the shipped M9 has no warnings — only ok / note / info rows', () => {
    const findings = verifyBoard(m9())
    expect(findings.filter((f) => f.severity === 'warn' || f.severity === 'error')).toEqual([])
    // Every SPI bus reports an `ok` chip-select row.
    expect(findings.some((f) => f.severity === 'ok' && /chip-selects/.test(f.message))).toBe(true)
  })

  it('flags the LCD_CS ↔ keyboard SCL collision when LCD_CS moves to GPIO21', () => {
    // M11's Done-when, minus the rebuild: GPIO21 already carries u8:SCL (I2C1).
    const findings = verifyBoard(rebind(m9(), 'u3', 'CS', 'GPIO21'))
    const collision = findings.find(
      (f) => f.severity === 'warn' && f.ref?.kind === 'pin' && f.ref.id === 'GPIO21'
    )
    expect(collision).toBeDefined()
    expect(collision!.message).toMatch(/u3:CS/)
    expect(collision!.message).toMatch(/u8:SCL/)
  })

  it('a declared pinException downgrades a double-bind to a note', () => {
    const board = rebind(m9(), 'u3', 'CS', 'GPIO21')
    const withException: BoardDefinition = { ...board, pinExceptions: ['GPIO21'] }
    const findings = verifyBoard(withException)
    expect(findings.some((f) => f.severity === 'warn' && f.ref?.id === 'GPIO21')).toBe(false)
    const note = findings.find((f) => f.severity === 'note' && f.ref?.id === 'GPIO21')
    expect(note).toBeDefined()
    expect(note!.message).toMatch(/intentional double-bind/)
  })

  it('two chip-selects on one pin raise a bus-contention warning', () => {
    // Park the SD card's CS on the LR1110's NSS pin.
    const findings = verifyBoard(rebind(m9(), 'u4', 'CS', 'GPIO39'))
    const busWarn = findings.find(
      (f) => f.severity === 'warn' && f.ref?.kind === 'bus' && /share GPIO39/.test(f.message)
    )
    expect(busWarn).toBeDefined()
    expect(busWarn!.message).toMatch(/two devices at once/)
  })

  it('flags a bus signal on a pin that cannot route it', () => {
    // Strip every capability but gpio from GPIO16, then put LCD_CS back on it —
    // CS needs spi routing.
    const board = m9()
    const stripped: BoardDefinition = {
      ...board,
      pins: board.pins.map((p) => (p.id === 'GPIO16' ? { ...p, capabilities: ['gpio'] } : p))
    }
    const findings = verifyBoard(stripped)
    expect(
      findings.some(
        (f) =>
          f.severity === 'warn' && /no spi capability/.test(f.message) && /GPIO16/.test(f.message)
      )
    ).toBe(true)
  })

  it('findingsToDiagnostics gives stable ids and preserves severity', () => {
    const findings = verifyBoard(m9())
    const rows = findingsToDiagnostics(findings)
    expect(rows).toHaveLength(findings.length)
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
    expect(rows[0]!.severity).toBe(findings[0]!.severity)
  })
})
