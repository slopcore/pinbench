// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBoard, type BoardDefinition } from './board'
import {
  checkHeaderDivergence,
  generateBuildFlags,
  generatePinHeader,
  headerFingerprint,
  HEADER_SENTINEL
} from './codegen'

function m9(): BoardDefinition {
  return parseBoard(
    JSON.parse(
      readFileSync(resolve(__dirname, '../../boards/thinknode-m9-v1.0.board.json'), 'utf8')
    )
  )
}

const GOLDEN = readFileSync(resolve(__dirname, '__fixtures__/thinknode-m9-v1.0.pins.h'), 'utf8')

function moveLcdCs(board: BoardDefinition, pin: string): BoardDefinition {
  return {
    ...board,
    parts: board.parts.map((p) =>
      p.id !== 'u3' ? p : { ...p, pins: p.pins.map((b) => (b.signal === 'CS' ? { ...b, pin } : b)) }
    ),
    nets: board.nets.map((n) =>
      n.id !== 'net-lcd-cs' ? n : { ...n, nodes: n.nodes.map((x) => (/^GPIO/.test(x) ? pin : x)) }
    )
  }
}

describe('generatePinHeader', () => {
  it('matches the checked-in golden header for the M9', () => {
    expect(generatePinHeader(m9())).toBe(GOLDEN)
  })

  it('is deterministic', () => {
    expect(generatePinHeader(m9())).toBe(generatePinHeader(m9()))
  })

  it('leads with the DO-NOT-EDIT sentinel', () => {
    expect(generatePinHeader(m9()).startsWith(HEADER_SENTINEL)).toBe(true)
  })

  it('moving LCD_CS to GPIO21 changes exactly the LCD_CS / U3_CS_PIN lines', () => {
    const before = generatePinHeader(m9()).split('\n')
    const after = generatePinHeader(moveLcdCs(m9(), 'GPIO21')).split('\n')
    const changed = after.filter((line, i) => line !== before[i])
    // Only the two defines that reference the LCD chip select move.
    expect(changed.map((l) => l.split(/\s+/)[1]).sort()).toEqual(['LCD_CS', 'U3_CS_PIN'])
    expect(after.find((l) => l.startsWith('#define LCD_CS '))).toMatch(/\b21\b/)
  })
})

describe('generateBuildFlags', () => {
  it('carries the same numbers as the header', () => {
    const flags = generateBuildFlags(m9())
    expect(flags).toContain('-D LR_NSS=39')
    expect(flags).toContain('-D U3_CS_PIN=16')
    // one -D per #define line in the header
    const defineCount = GOLDEN.split('\n').filter(
      (l) => l.startsWith('#define ') && /\d\s+\/\*/.test(l)
    ).length
    expect(flags).toHaveLength(defineCount)
  })
})

describe('headerFingerprint', () => {
  it('ignores comments and spacing, tracks the pin numbers', () => {
    const h = generatePinHeader(m9())
    const reformatted = h
      .split('\n')
      .map((l) => l.replace(/\s*\/\*.*\*\/\s*$/, '').replace(/ {2,}/g, ' '))
      .join('\n')
    expect(headerFingerprint(reformatted)).toBe(headerFingerprint(h))
  })

  it('changes when a pin number changes', () => {
    expect(headerFingerprint(generatePinHeader(moveLcdCs(m9(), 'GPIO21')))).not.toBe(
      headerFingerprint(generatePinHeader(m9()))
    )
  })
})

describe('checkHeaderDivergence — the round-trip guard', () => {
  const header = generatePinHeader(m9())
  const fp = headerFingerprint(header)

  it('no file yet is not a divergence', () => {
    expect(checkHeaderDivergence('', fp).diverged).toBe(false)
    expect(checkHeaderDivergence(null, fp).diverged).toBe(false)
  })

  it('an unchanged generated file is clean', () => {
    expect(checkHeaderDivergence(header, fp)).toEqual({ diverged: false, foreign: false })
  })

  it('a hand-edit of the generated file is flagged', () => {
    const edited = header.replace('#define LR_NSS            39', '#define LR_NSS            21')
    expect(checkHeaderDivergence(edited, fp)).toEqual({ diverged: true, foreign: false })
  })

  it('a file PinBench never wrote is foreign and flagged', () => {
    expect(checkHeaderDivergence('#define LR_NSS 39\n', fp)).toEqual({
      diverged: true,
      foreign: true
    })
  })
})
