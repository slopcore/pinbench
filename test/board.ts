import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseBoard } from '../src/shared/board'

/**
 * The real M9 definition, read from `boards/` and validated exactly as the app
 * reads it. Tests that need a board use this rather than a hand-built literal,
 * so a break in the shipped definition breaks the suite. Vitest runs from the
 * repo root, so a cwd-relative path is stable.
 */
export const M9_BOARD_PATH = resolve('boards/thinknode-m9-v1.0.board.json')

export const M9_BOARD = parseBoard(JSON.parse(readFileSync(M9_BOARD_PATH, 'utf8')))
