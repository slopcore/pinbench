import { describe, expect, it } from 'vitest'
import { availableBoardIds, boardsDir, DEFAULT_BOARD_ID, loadBoard } from './board'

describe('loadBoard', () => {
  it('reads and validates the shipped M9 definition', () => {
    const board = loadBoard('thinknode-m9-v1.0')
    expect(board.id).toBe('thinknode-m9-v1.0')
    expect(board.emulator.psramOctal).toBe(true)
  })

  it('resolves to the named default when no id is given, regardless of what else is on disk', () => {
    // More than one *.board.json now ships; an id-less load must still be the M9.
    expect(availableBoardIds().length).toBeGreaterThan(1)
    expect(availableBoardIds()).toContain(DEFAULT_BOARD_ID)
    expect(loadBoard().id).toBe(DEFAULT_BOARD_ID)
    expect(loadBoard('').id).toBe(DEFAULT_BOARD_ID)
    expect(loadBoard(undefined).id).toBe(DEFAULT_BOARD_ID)
  })

  it('reads and validates the Heltec Wireless Paper definition', () => {
    const board = loadBoard('heltec-wireless-paper-v1.1')
    expect(board.id).toBe('heltec-wireless-paper-v1.1')
    expect(board.vendor).toBe('Heltec')
    // Two SPI buses — the radio and the e-ink panel do not share one.
    expect(
      board.buses
        .filter((b) => b.kind === 'spi')
        .map((b) => b.id)
        .sort()
    ).toEqual(['spi-disp', 'spi-radio'])
    // No PSRAM on this part.
    expect(board.emulator.psramSize).toBeUndefined()
    expect(board.emulator.flashSize).toBe('8M')
  })

  it('rejects an id with path characters before touching the filesystem', () => {
    expect(() => loadBoard('../secrets')).toThrow(/invalid board id/)
    expect(() => loadBoard('a/b')).toThrow(/invalid board id/)
  })

  it('throws a helpful error for a missing file', () => {
    expect(() => loadBoard('no-such-board')).toThrow(/no board definition at/)
  })

  it('resolves board files under a boards/ directory', () => {
    expect(boardsDir()).toMatch(/boards$/)
  })
})
