import { describe, expect, it } from 'vitest'
import { BoardValidationError, boardTotals, parseBoard, partsByCategory } from './board'

/** A minimal but complete definition the tests mutate to make each rule fire. */
function validBoard(): Record<string, unknown> {
  return {
    schema: 1,
    id: 'test-board',
    name: 'Test Board',
    mcu: 'ESP32-S3',
    vendor: 'Acme',
    pins: [
      { id: 'GPIO1', label: 'IO1', capabilities: ['gpio', 'spi'] },
      { id: 'GPIO2', label: 'IO2', capabilities: ['gpio', 'i2c'] },
      { id: 'GPIO3', label: 'IO3', capabilities: ['gpio'] }
    ],
    buses: [{ id: 'spi0', kind: 'spi', label: 'SPI0', signals: { sck: 'GPIO1' }, clockHz: 1000 }],
    parts: [
      {
        id: 'u1',
        designator: 'U1',
        name: 'MCU',
        category: 'mcu',
        summary: 'the brain',
        buses: ['spi0'],
        pins: [],
        config: [],
        layout: { x: 0, y: 0, width: 10, height: 10 }
      },
      {
        id: 'u2',
        designator: 'U2',
        name: 'Widget',
        category: 'sensor',
        deviceModel: 'acme.widget',
        summary: 'a widget',
        buses: ['spi0'],
        pins: [{ signal: 'CS', pin: 'GPIO2' }],
        config: [{ id: 'mode', label: 'Mode', kind: 'segmented', options: ['a', 'b'], value: 'a' }],
        layout: { x: 0, y: 0, width: 10, height: 10 }
      }
    ],
    nets: [{ id: 'n1', label: 'CS', bus: 'spi0', nodes: ['GPIO2', 'u2:CS'] }],
    emulator: { machine: 'esp32s3', psramSize: '8M', psramOctal: true },
    canvas: { width: 100, height: 100 }
  }
}

describe('parseBoard', () => {
  it('accepts a well-formed definition and returns a typed board', () => {
    const board = parseBoard(validBoard())
    expect(board.id).toBe('test-board')
    expect(boardTotals(board)).toEqual({ parts: 2, nets: 1, assignedGpio: 1 })
    expect(partsByCategory(board).get('mcu')).toHaveLength(1)
  })

  it('rejects a bus signal that is not a declared pin, naming the field', () => {
    const raw = validBoard()
    ;(raw['buses'] as { signals: Record<string, string> }[])[0]!.signals['sck'] = 'GPIO99'
    expect(() => parseBoard(raw)).toThrow(BoardValidationError)
    expect(() => parseBoard(raw)).toThrow(/board\.buses\[0\]\.signals\.sck.*GPIO99/)
  })

  it('rejects a part pin bound to an undeclared pin', () => {
    const raw = validBoard()
    ;(raw['parts'] as { pins: { signal: string; pin: string }[] }[])[1]!.pins[0]!.pin = 'GPIO42'
    expect(() => parseBoard(raw)).toThrow(/board\.parts\[1\]\.pins\[0\]\.pin.*GPIO42/)
  })

  it('rejects a part on a bus the board does not declare', () => {
    const raw = validBoard()
    ;(raw['parts'] as { buses: string[] }[])[1]!.buses = ['i2c9']
    expect(() => parseBoard(raw)).toThrow(/board\.parts\[1\]\.buses\[0\].*i2c9/)
  })

  it('rejects a net endpoint that resolves to no part signal', () => {
    const raw = validBoard()
    ;(raw['nets'] as { nodes: string[] }[])[0]!.nodes = ['u2:NOPE']
    expect(() => parseBoard(raw)).toThrow(/board\.nets\[0\]\.nodes\[0\].*NOPE/)
  })

  it('rejects a net on an undeclared bus', () => {
    const raw = validBoard()
    ;(raw['nets'] as { bus: string }[])[0]!.bus = 'spi9'
    expect(() => parseBoard(raw)).toThrow(/board\.nets\[0\]\.bus.*spi9/)
  })

  it('rejects duplicate pin ids', () => {
    const raw = validBoard()
    ;(raw['pins'] as { id: string }[])[1]!.id = 'GPIO1'
    expect(() => parseBoard(raw)).toThrow(/board\.pins.*duplicate id "GPIO1"/)
  })

  it('rejects a board without exactly one mcu part', () => {
    const raw = validBoard()
    ;(raw['parts'] as { category: string }[])[1]!.category = 'mcu'
    expect(() => parseBoard(raw)).toThrow(/exactly one "mcu" part, found 2/)
  })

  it('rejects an unknown schema version', () => {
    expect(() => parseBoard({ ...validBoard(), schema: 2 })).toThrow(/board\.schema/)
  })

  it('rejects a non-object', () => {
    expect(() => parseBoard(null)).toThrow(BoardValidationError)
    expect(() => parseBoard('nope')).toThrow(/board: expected an object/)
  })

  it('parses an optional firmwareHook and keeps its optional fields optional', () => {
    const raw = validBoard()
    ;(raw.parts as Record<string, unknown>[])[1]!.firmwareHook = {
      symbol: 'Widget::begin()',
      file: 'src/Widget.cpp',
      line: 12,
      note: 'brings the widget up'
    }
    ;(raw.parts as Record<string, unknown>[])[0]!.firmwareHook = { symbol: 'app_main()' }
    const board = parseBoard(raw)
    expect(board.parts[1]!.firmwareHook).toEqual({
      symbol: 'Widget::begin()',
      file: 'src/Widget.cpp',
      line: 12,
      note: 'brings the widget up'
    })
    expect(board.parts[0]!.firmwareHook).toEqual({ symbol: 'app_main()' })
  })

  it('rejects a firmwareHook with no symbol, naming the field', () => {
    const raw = validBoard()
    ;(raw.parts as Record<string, unknown>[])[1]!.firmwareHook = { file: 'src/x.cpp' }
    expect(() => parseBoard(raw)).toThrow(/board\.parts\[1\]\.firmwareHook\.symbol/)
  })
})
