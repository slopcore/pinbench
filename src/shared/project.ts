/**
 * The `.pinbench` project file: what a workbench session is *about*, as opposed
 * to how the window happens to be arranged (that stays in `session.json`, see
 * `src/main/store.ts`).
 *
 * It records the board, the PlatformIO checkout and environment the firmware is
 * built from, the per-part Inspector config, and which part is selected. Canvas
 * pan/zoom and panel layout are deliberately *not* here — they are shell state,
 * not project state, and M11/M12 revisit the split when canvas editing lands.
 *
 * Like the workspace and session stores, a project file is a convenience and
 * never a contract: a truncated or hand-edited file degrades to sensible
 * defaults rather than failing the open. Board definitions are the opposite —
 * those fail loud (`parseBoard`).
 */

import type { BoardEdit } from './boardEdit'

export type PartConfigValue = string | number | boolean

const BOARD_EDIT_KINDS = new Set([
  'moveParty',
  'resizeParty',
  'rebindPin',
  'addPart',
  'deletePart',
  'addNet',
  'deleteNet'
])

export interface ProjectFile {
  /** Bumped when a field is removed or its meaning changes. */
  version: 1
  /**
   * Board definition id, resolved against `boards/<id>.board.json`. Empty means
   * "the workbench default board" — the sole definition on disk today, the
   * board picker's choice from M13. No board id is hardcoded in `src/`.
   */
  boardId: string
  /** Absolute path to the PlatformIO project, or null if none is attached. */
  platformioDir: string | null
  /** Selected build environment from `platformio.ini`. */
  env: string | null
  /** `${partId}.${fieldId}` → value, from the Inspector. */
  partConfig: Record<string, PartConfigValue>
  /** The part shown in the Inspector when the file was saved. */
  selectedPartId: string | null
  /**
   * Canvas edits, oldest first, replayed over the board definition on open. A
   * stale edit (part since removed from the definition) is skipped on replay.
   */
  boardEdits: BoardEdit[]
}

export const DEFAULT_PROJECT: ProjectFile = {
  version: 1,
  boardId: '',
  platformioDir: null,
  env: null,
  partConfig: {},
  selectedPartId: null,
  boardEdits: []
}

/** Coerce whatever is on disk into a usable project; never throw at the caller. */
export function normaliseProject(input: unknown): ProjectFile {
  if (typeof input !== 'object' || input === null) return { ...DEFAULT_PROJECT }
  const raw = input as Partial<ProjectFile>
  if (raw.version !== DEFAULT_PROJECT.version) return { ...DEFAULT_PROJECT }

  const partConfig: Record<string, PartConfigValue> = {}
  if (raw.partConfig && typeof raw.partConfig === 'object') {
    for (const [key, value] of Object.entries(raw.partConfig)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        partConfig[key] = value
      }
    }
  }

  const boardEdits = Array.isArray(raw.boardEdits)
    ? (raw.boardEdits.filter(
        (edit): edit is BoardEdit =>
          typeof edit === 'object' &&
          edit !== null &&
          BOARD_EDIT_KINDS.has((edit as { kind?: unknown }).kind as string)
      ) as BoardEdit[])
    : []

  return {
    version: 1,
    boardId: typeof raw.boardId === 'string' ? raw.boardId : '',
    platformioDir: typeof raw.platformioDir === 'string' ? raw.platformioDir : null,
    env: typeof raw.env === 'string' ? raw.env : null,
    partConfig,
    selectedPartId: typeof raw.selectedPartId === 'string' ? raw.selectedPartId : null,
    boardEdits
  }
}

export function serialiseProject(project: ProjectFile): string {
  return JSON.stringify(project, null, 2) + '\n'
}

export const PROJECT_FILE_EXTENSION = 'pinbench'
