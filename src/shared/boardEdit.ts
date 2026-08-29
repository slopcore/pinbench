/**
 * Board-definition edits and an undo/redo history (roadmap M11.3).
 *
 * The canvas is a view over a {@link BoardDefinition}; every edit — drag a
 * part, draw a net, move a peripheral to another GPIO, add or delete a part —
 * is a pure transform producing a new definition, so codegen (M11.2) and
 * verify (M11.1) always read the live state and undo/redo is a stack of these
 * transforms. No Electron/DOM: the canvas component dispatches, this module
 * computes.
 */

import type { BoardDefinition, NetDefinition, PartDefinition } from './board'

export type BoardEdit =
  | { kind: 'moveParty'; partId: string; x: number; y: number }
  | { kind: 'resizeParty'; partId: string; width: number; height: number }
  /** Point a part's own signal at a different board pin. */
  | { kind: 'rebindPin'; partId: string; signal: string; pin: string }
  | { kind: 'addPart'; part: PartDefinition }
  | { kind: 'deletePart'; partId: string }
  | { kind: 'addNet'; net: NetDefinition }
  | { kind: 'deleteNet'; netId: string }

export class BoardEditError extends Error {}

/** Apply one edit, returning a new board. Throws {@link BoardEditError} on a bad ref. */
export function applyEdit(board: BoardDefinition, edit: BoardEdit): BoardDefinition {
  switch (edit.kind) {
    case 'moveParty':
      return mapPart(board, edit.partId, (p) => ({
        ...p,
        layout: { ...p.layout, x: edit.x, y: edit.y }
      }))
    case 'resizeParty':
      return mapPart(board, edit.partId, (p) => ({
        ...p,
        layout: { ...p.layout, width: edit.width, height: edit.height }
      }))
    case 'rebindPin': {
      if (!board.pins.some((pin) => pin.id === edit.pin)) {
        throw new BoardEditError(`no board pin "${edit.pin}"`)
      }
      return mapPart(board, edit.partId, (p) => {
        if (!p.pins.some((b) => b.signal === edit.signal)) {
          throw new BoardEditError(`${edit.partId} has no signal "${edit.signal}"`)
        }
        return {
          ...p,
          pins: p.pins.map((b) => (b.signal === edit.signal ? { ...b, pin: edit.pin } : b))
        }
      })
    }
    case 'addPart':
      if (board.parts.some((p) => p.id === edit.part.id)) {
        throw new BoardEditError(`part "${edit.part.id}" already exists`)
      }
      return { ...board, parts: [...board.parts, edit.part] }
    case 'deletePart': {
      if (!board.parts.some((p) => p.id === edit.partId)) {
        throw new BoardEditError(`no part "${edit.partId}"`)
      }
      return {
        ...board,
        parts: board.parts.filter((p) => p.id !== edit.partId),
        // Drop any net endpoint that referenced the part; keep the net if it
        // still has two or more nodes, otherwise remove it.
        nets: board.nets
          .map((n) => ({
            ...n,
            nodes: n.nodes.filter((node) => !node.startsWith(`${edit.partId}:`))
          }))
          .filter((n) => n.nodes.length >= 2)
      }
    }
    case 'addNet':
      if (board.nets.some((n) => n.id === edit.net.id)) {
        throw new BoardEditError(`net "${edit.net.id}" already exists`)
      }
      return { ...board, nets: [...board.nets, edit.net] }
    case 'deleteNet':
      if (!board.nets.some((n) => n.id === edit.netId)) {
        throw new BoardEditError(`no net "${edit.netId}"`)
      }
      return { ...board, nets: board.nets.filter((n) => n.id !== edit.netId) }
  }
}

/**
 * A fresh part id / designator that does not collide with anything on the
 * board — `u3` → `u3-copy`, then `u3-copy-2`, … and `U3` → `U3B`, `U3C`, …
 * (a letter suffix, not an apostrophe, so the designator stays a distinct C
 * identifier through {@link generatePinHeader}'s `ident()`).
 */
export function duplicatePart(source: PartDefinition, board: BoardDefinition): PartDefinition {
  const takenIds = new Set(board.parts.map((p) => p.id))
  let id = `${source.id}-copy`
  for (let n = 2; takenIds.has(id); n += 1) id = `${source.id}-copy-${n}`

  const takenDesignators = new Set(board.parts.map((p) => p.designator))
  let designator = `${source.designator}B`
  for (let c = 66; takenDesignators.has(designator) && c < 90; c += 1) {
    designator = `${source.designator}${String.fromCharCode(c + 1)}`
  }

  return {
    ...source,
    id,
    designator,
    // Nudge it clear of the original so both are visible.
    layout: { ...source.layout, x: source.layout.x + 24, y: source.layout.y + 24 },
    // A copy carries no net endpoints and no device model — it is a fresh
    // placement the user then wires up.
    pins: source.pins.map((b) => ({ ...b }))
  }
}

/**
 * Lay every non-MCU part out in bus-grouped columns to the right of the MCU,
 * wrapping to a new row band before the columns run off the board outline.
 * Returns one `moveParty` edit per part that needs to move.
 */
export function autoArrangeByBus(board: BoardDefinition): BoardEdit[] {
  const mcu = board.parts.find((p) => p.category === 'mcu')
  if (!mcu) return []
  const others = board.parts.filter((p) => p.id !== mcu.id)
  // Group by the part's first bus, then everything else — one column per group.
  const groups = new Map<string, PartDefinition[]>()
  for (const part of others) {
    const key = part.buses[0] ?? '—'
    const bucket = groups.get(key)
    if (bucket) bucket.push(part)
    else groups.set(key, [part])
  }

  const colGap = 200
  const rowGap = 140
  const startX = Math.min(mcu.layout.x + mcu.layout.width + 100, board.canvas.width - colGap)
  const startY = 40
  // How many columns fit before the right edge.
  const colsPerBand = Math.max(1, Math.floor((board.canvas.width - startX) / colGap))

  const edits: BoardEdit[] = []
  let col = 0
  for (const bucket of groups.values()) {
    const band = Math.floor(col / colsPerBand)
    const bandTop = startY + band * (rowGap * 4 + rowGap)
    bucket.forEach((part, row) => {
      const x = startX + (col % colsPerBand) * colGap
      const y = bandTop + row * rowGap
      if (part.layout.x !== x || part.layout.y !== y) {
        edits.push({ kind: 'moveParty', partId: part.id, x, y })
      }
    })
    col += 1
  }
  return edits
}

function mapPart(
  board: BoardDefinition,
  partId: string,
  fn: (p: PartDefinition) => PartDefinition
): BoardDefinition {
  if (!board.parts.some((p) => p.id === partId)) {
    throw new BoardEditError(`no part "${partId}"`)
  }
  return { ...board, parts: board.parts.map((p) => (p.id === partId ? fn(p) : p)) }
}

/**
 * A linear undo/redo history over board edits. `present` is the current board;
 * `apply` pushes an edit and clears the redo stack; `undo`/`redo` walk it.
 * Immutable snapshots, so the renderer can hold references across renders.
 */
export class BoardHistory {
  private past: BoardDefinition[] = []
  private future: BoardDefinition[] = []

  constructor(private current: BoardDefinition) {}

  get present(): BoardDefinition {
    return this.current
  }
  get canUndo(): boolean {
    return this.past.length > 0
  }
  get canRedo(): boolean {
    return this.future.length > 0
  }

  /** Apply an edit. Throws (and leaves history untouched) on a bad edit. */
  apply(edit: BoardEdit): BoardDefinition {
    const next = applyEdit(this.current, edit)
    this.past.push(this.current)
    this.current = next
    this.future = []
    return next
  }

  undo(): BoardDefinition {
    const prev = this.past.pop()
    if (prev === undefined) return this.current
    this.future.push(this.current)
    this.current = prev
    return this.current
  }

  redo(): BoardDefinition {
    const next = this.future.pop()
    if (next === undefined) return this.current
    this.past.push(this.current)
    this.current = next
    return this.current
  }
}
