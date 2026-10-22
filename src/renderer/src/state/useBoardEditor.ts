import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BoardDefinition } from '@shared/board'
import { applyEdit, type BoardEdit } from '@shared/boardEdit'

/**
 * Canvas-editing state over a base {@link BoardDefinition}. The base is the
 * validated definition from disk; edits are a linear history of pure
 * {@link BoardEdit} transforms grouped into transactions, so an "auto-arrange"
 * that moves nine parts is a single undo step. `board` is the base with the
 * applied transactions folded in — Verify, codegen and the canvas all read the
 * live state, and undo/redo just move a cursor.
 *
 * The applied slice, flattened (`edits`), is what the `.pinbench` file persists;
 * a bad edit is dropped on replay rather than failing the open.
 */
export interface BoardEditor {
  /** Base board with `edits` applied. */
  board: BoardDefinition
  /** The edits currently in effect, oldest first — persist these. */
  edits: BoardEdit[]
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  apply: (edit: BoardEdit) => void
  /** Apply several edits as one undo step (e.g. auto-arrange). */
  applyMany: (edits: BoardEdit[]) => void
  undo: () => void
  redo: () => void
  /** Replace the whole history (e.g. after opening a project file). */
  load: (edits: BoardEdit[]) => void
}

/** Fold an edit list onto a base board, skipping any edit that no longer applies. */
export function replayEdits(base: BoardDefinition, edits: BoardEdit[]): BoardDefinition {
  let board = base
  for (const edit of edits) {
    try {
      board = applyEdit(board, edit)
    } catch {
      /* a stale edit (part since removed, pin renamed) — skip it */
    }
  }
  return board
}

type Txn = BoardEdit[]
interface HistoryState {
  txns: Txn[]
  /** Number of transactions currently applied. */
  cursor: number
}

export function useBoardEditor(base: BoardDefinition, initialEdits: BoardEdit[] = []): BoardEditor {
  const [state, setState] = useState<HistoryState>(() => ({
    txns: initialEdits.map((edit) => [edit]),
    cursor: initialEdits.length
  }))

  // The base changes only when the user switches boards — start fresh then.
  const baseIdRef = useRef(base.id)
  useEffect(() => {
    if (baseIdRef.current !== base.id) {
      baseIdRef.current = base.id
      setState({ txns: [], cursor: 0 })
    }
  }, [base.id])

  const edits = useMemo(() => state.txns.slice(0, state.cursor).flat(), [state.txns, state.cursor])
  const board = useMemo(() => replayEdits(base, edits), [base, edits])

  const commit = useCallback((txn: Txn) => {
    if (txn.length === 0) return
    setState((s) => ({ txns: [...s.txns.slice(0, s.cursor), txn], cursor: s.cursor + 1 }))
  }, [])
  const apply = useCallback((edit: BoardEdit) => commit([edit]), [commit])
  const applyMany = useCallback((next: BoardEdit[]) => commit(next), [commit])
  const undo = useCallback(() => setState((s) => ({ ...s, cursor: Math.max(0, s.cursor - 1) })), [])
  const redo = useCallback(
    () => setState((s) => ({ ...s, cursor: Math.min(s.txns.length, s.cursor + 1) })),
    []
  )
  const load = useCallback(
    (next: BoardEdit[]) => setState({ txns: next.map((edit) => [edit]), cursor: next.length }),
    []
  )

  return {
    board,
    edits,
    dirty: edits.length > 0,
    canUndo: state.cursor > 0,
    canRedo: state.cursor < state.txns.length,
    apply,
    applyMany,
    undo,
    redo,
    load
  }
}
