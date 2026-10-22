/**
 * Loading a board definition from disk.
 *
 * The definition is read with `fs` at request time, not `import`ed — a bundled
 * `import` (even of JSON) compiles the board into the app, and M5's contract is
 * that editing `boards/<id>.board.json` changes what PinBench shows. The
 * sandboxed renderer has no filesystem access, so this lives in the main
 * process; the renderer asks for a board over IPC and the host also hands the
 * parsed definition straight to `DeviceHost` without a renderer round trip.
 *
 * `loadBoard()` with no id resolves one deterministically: the caller's id (the
 * open project's `boardId`) wins, then the named default {@link DEFAULT_BOARD_ID},
 * then — only when neither is on disk — the sole `*.board.json`. Before M13 this
 * was "first file alphabetically", which meant dropping a second board in
 * `boards/` silently flipped the default out from under the M9.
 */

import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { parseBoard, type BoardDefinition } from '../shared/board'

const SUFFIX = '.board.json'

/** A board id must be a safe single path segment — it becomes a filename. */
const BOARD_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i

/**
 * The board loaded when nothing else names one — the first target board, and
 * the identity every M9 test and the M1 shell assume. Adding another
 * `*.board.json` must not change what an id-less `loadBoard()` returns.
 */
export const DEFAULT_BOARD_ID = 'thinknode-m9-v1.0'

/** Where `<id>.board.json` files live: the repo root in dev, resources when packaged. */
export function boardsDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'boards') : join(app.getAppPath(), 'boards')
}

/** Board ids available on disk, sorted. */
export function availableBoardIds(): string[] {
  return readdirSync(boardsDir())
    .filter((name) => name.endsWith(SUFFIX))
    .map((name) => name.slice(0, -SUFFIX.length))
    .sort()
}

/**
 * Read, parse and fully validate a board definition. With no id (or an empty
 * one) the resolution order is {@link DEFAULT_BOARD_ID} if it is on disk, else
 * the single definition present, else an error. Throws `BoardValidationError`
 * (with the offending field path) on a malformed file, or a plain `Error` if
 * the file is missing or not JSON.
 */
export function loadBoard(id?: string): BoardDefinition {
  let boardId = id?.trim() ?? ''
  if (!boardId) {
    const ids = availableBoardIds()
    if (ids.length === 0) throw new Error(`no board definitions in ${boardsDir()}`)
    boardId = ids.includes(DEFAULT_BOARD_ID) ? DEFAULT_BOARD_ID : ids[0]!
  }
  if (!BOARD_ID_RE.test(boardId)) {
    throw new Error(`invalid board id "${boardId}"`)
  }
  const file = join(boardsDir(), `${boardId}${SUFFIX}`)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`no board definition at ${file}`)
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} is not valid JSON`, { cause: error })
  }
  return parseBoard(json)
}

/**
 * Write `definition` as `boards/<id>.board.json` — how the user turns canvas
 * edits into a shareable hardware profile. The definition is validated (and
 * normalised through {@link parseBoard}) before it touches disk, and its `id`
 * is forced to match `id` so the file name and the definition never disagree.
 * The write is atomic. Returns the parsed definition as written.
 */
export function saveBoardProfile(id: string, definition: unknown): BoardDefinition {
  const boardId = id.trim()
  if (!BOARD_ID_RE.test(boardId)) throw new Error(`invalid board id "${boardId}"`)
  const parsed = parseBoard(
    typeof definition === 'object' && definition !== null
      ? { ...(definition as Record<string, unknown>), id: boardId }
      : definition
  )
  const file = join(boardsDir(), `${boardId}${SUFFIX}`)
  const temporary = `${file}.tmp`
  writeFileSync(temporary, JSON.stringify(parsed, null, 2) + '\n', 'utf8')
  renameSync(temporary, file)
  return parsed
}
