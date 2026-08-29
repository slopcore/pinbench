// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { boardTotals, parseBoard, type BoardDefinition } from './board'
import { applyEdit } from './boardEdit'
import { verifyBoard } from './verify'
import { CATALOGUE, instantiateCatalogueEntry } from './catalogue'

function m9(): BoardDefinition {
  return parseBoard(
    JSON.parse(
      readFileSync(resolve(__dirname, '../../boards/thinknode-m9-v1.0.board.json'), 'utf8')
    )
  )
}

describe('CATALOGUE', () => {
  it('has the expansion and firmware groups the design lists', () => {
    const titles = CATALOGUE.map((g) => g.title)
    expect(titles).toEqual(['Expansion · generic', 'Firmware modules'])
    const expansion = CATALOGUE[0]!.entries.map((e) => e.name)
    expect(expansion).toEqual(
      expect.arrayContaining(['LED', 'Momentary button', 'NeoPixel strip', 'DHT22', 'Servo'])
    )
  })
})

describe('instantiateCatalogueEntry', () => {
  it('produces a board-unique id and a placeable part', () => {
    const board = m9()
    const led = CATALOGUE[0]!.entries.find((e) => e.key === 'led')!
    const taken = new Set(board.parts.map((p) => p.id))
    const part = instantiateCatalogueEntry(led, taken, { x: 100, y: 100 })
    expect(part.id).toBe('led')
    expect(() => applyEdit(board, { kind: 'addPart', part })).not.toThrow()

    const withLed = applyEdit(board, { kind: 'addPart', part })
    const second = instantiateCatalogueEntry(led, new Set(withLed.parts.map((p) => p.id)), {
      x: 0,
      y: 0
    })
    expect(second.id).toBe('led-2')
  })

  it('places with no pin bindings, so Verify and the GPIO count are untouched', () => {
    const board = m9()
    const led = CATALOGUE[0]!.entries.find((e) => e.key === 'led')!
    const part = instantiateCatalogueEntry(led, new Set(board.parts.map((p) => p.id)), {
      x: 0,
      y: 0
    })
    expect(part.pins).toEqual([])
    const withLed = applyEdit(board, { kind: 'addPart', part })
    expect(boardTotals(withLed).assignedGpio).toBe(boardTotals(board).assignedGpio)
    expect(() => verifyBoard(withLed)).not.toThrow()
  })
})
