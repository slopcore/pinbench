import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  availableBoardIds,
  boardsDir,
  DEFAULT_BOARD_ID,
  loadBoard,
  saveBoardProfile
} from './board'

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

describe('saveBoardProfile', () => {
  const SCRATCH_ID = 'zz-test-tmp-profile'
  afterEach(() => {
    rmSync(join(boardsDir(), `${SCRATCH_ID}.board.json`), { force: true })
  })

  it('writes a validated definition that loadBoard round-trips, id forced to match', () => {
    const source = loadBoard('heltec-wireless-paper-v1.1')
    // Pass a mismatched id in the body — the filename wins.
    const written = saveBoardProfile(SCRATCH_ID, { ...source, id: 'something-else' })
    expect(written.id).toBe(SCRATCH_ID)
    expect(loadBoard(SCRATCH_ID).id).toBe(SCRATCH_ID)
    expect(availableBoardIds()).toContain(SCRATCH_ID)
  })

  it('rejects an id with path characters before touching the filesystem', () => {
    expect(() => saveBoardProfile('../evil', {})).toThrow(/invalid board id/)
    expect(() => saveBoardProfile('a/b', {})).toThrow(/invalid board id/)
  })

  it('rejects a definition that fails board validation', () => {
    expect(() => saveBoardProfile(SCRATCH_ID, { schema: 1, id: SCRATCH_ID })).toThrow()
    expect(availableBoardIds()).not.toContain(SCRATCH_ID)
  })
})
