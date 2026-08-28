import { describe, expect, it } from 'vitest'
import { availableBoardIds, boardsDir, loadBoard } from './board'

describe('loadBoard', () => {
  it('reads and validates the shipped M9 definition', () => {
    const board = loadBoard('thinknode-m9-v1.0')
    expect(board.id).toBe('thinknode-m9-v1.0')
    expect(board.emulator.psramOctal).toBe(true)
  })

  it('discovers the sole definition on disk when no id is given', () => {
    expect(availableBoardIds()).toContain('thinknode-m9-v1.0')
    expect(loadBoard().id).toBe(loadBoard('').id)
    expect(loadBoard(undefined).id).toBe('thinknode-m9-v1.0')
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
