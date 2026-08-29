import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { BoardEdit } from '@shared/boardEdit'
import { M9_BOARD } from '../../../../test/board'
import { replayEdits, useBoardEditor } from './useBoardEditor'

const move = (x: number, y: number): BoardEdit => ({ kind: 'moveParty', partId: 'u3', x, y })

describe('replayEdits', () => {
  it('folds edits and skips one that no longer applies', () => {
    const board = replayEdits(M9_BOARD, [
      move(10, 20),
      { kind: 'deletePart', partId: 'does-not-exist' },
      move(30, 40)
    ])
    expect(board.parts.find((p) => p.id === 'u3')!.layout).toMatchObject({ x: 30, y: 40 })
  })
})

describe('useBoardEditor', () => {
  it('applies, undoes and redoes edits and tracks dirty', () => {
    const { result } = renderHook(() => useBoardEditor(M9_BOARD))
    expect(result.current.dirty).toBe(false)

    act(() => result.current.apply(move(1, 2)))
    act(() => result.current.apply(move(3, 4)))
    expect(result.current.board.parts.find((p) => p.id === 'u3')!.layout).toMatchObject({
      x: 3,
      y: 4
    })
    expect(result.current.edits).toHaveLength(2)
    expect(result.current.dirty).toBe(true)

    act(() => result.current.undo())
    expect(result.current.board.parts.find((p) => p.id === 'u3')!.layout).toMatchObject({
      x: 1,
      y: 2
    })
    expect(result.current.canRedo).toBe(true)

    act(() => result.current.redo())
    expect(result.current.edits).toHaveLength(2)

    // A new edit after an undo truncates the redo branch.
    act(() => result.current.undo())
    act(() => result.current.apply(move(9, 9)))
    expect(result.current.canRedo).toBe(false)
    expect(result.current.edits).toEqual([move(1, 2), move(9, 9)])
  })

  it('applyMany is a single undo step', () => {
    const { result } = renderHook(() => useBoardEditor(M9_BOARD))
    act(() => result.current.applyMany([move(1, 1), move(2, 2), move(3, 3)]))
    expect(result.current.edits).toHaveLength(3)
    act(() => result.current.undo())
    expect(result.current.edits).toHaveLength(0)
  })

  it('load replaces the history with a persisted edit list', () => {
    const { result } = renderHook(() => useBoardEditor(M9_BOARD))
    act(() => result.current.load([move(5, 5)]))
    expect(result.current.edits).toEqual([move(5, 5)])
    expect(result.current.canUndo).toBe(true)
  })
})
