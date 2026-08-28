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
 * No board id is hardcoded here: `loadBoard()` with no id discovers the sole
 * `*.board.json` on disk. M13 adds a board picker and this heuristic goes away.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { parseBoard, type BoardDefinition } from '../shared/board'

const SUFFIX = '.board.json'

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
 * one) the single definition on disk is used. Throws `BoardValidationError`
 * (with the offending field path) on a malformed file, or a plain `Error` if
 * the file is missing or not JSON.
 */
export function loadBoard(id?: string): BoardDefinition {
  let boardId = id?.trim() ?? ''
  if (!boardId) {
    const ids = availableBoardIds()
    if (ids.length === 0) throw new Error(`no board definitions in ${boardsDir()}`)
    boardId = ids[0]!
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(boardId)) {
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
