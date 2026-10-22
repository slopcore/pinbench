import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_WORKSPACE, normaliseWorkspace } from '../shared/workspace'
import type { WorkspaceState } from '../shared/workspace'
import type { PartConfigValue } from '../shared/partConfig'
import type { BoardEdit } from '../shared/boardEdit'

/**
 * Session state that survives a restart.
 *
 * The window and shell layout live here, and — since the `.pinbench` project
 * document was retired — so does everything that used to be *in* that document:
 * the recently opened firmware source folders, the last hardware profile, and
 * per-(folder, profile) build env + Inspector config. A folder plus a profile
 * is what a workbench session is "about"; neither is a file the user manages.
 * Writes are atomic — a half-written settings file must never be able to stop
 * the app from launching.
 */

export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximised: boolean
}

/** Remembered per (folder, hardware-profile) pair — see {@link folderStateKey}. */
export interface FolderState {
  /** Last build env picked from `platformio.ini` for this pair. */
  env: string | null
  /** `${partId}.${fieldId}` → value, from the Inspector. Keyed under the
   *  profile id so switching profiles cannot surface another board's part ids. */
  partConfig: Record<string, PartConfigValue>
  /** The canvas edit history (part moves/resizes, added parts, nets) folded
   *  over the on-disk profile. Replayed tolerantly on launch, so a stale edit
   *  is skipped rather than failing the open. */
  boardEdits: BoardEdit[]
}

export interface SessionState {
  version: 2
  window: WindowBounds
  workspace: WorkspaceState
  /** Absolute paths of recently opened firmware source folders, most recent first. */
  recentFolders: string[]
  /** The hardware profile id the user last selected, applied on next launch. */
  lastBoardId: string | null
  /** Per-(folder, profile) state, keyed by {@link folderStateKey}. */
  folders: Record<string, FolderState>
  /** When true, auto-approve agent ACP operations without prompting. */
  acpAutoApprove?: boolean
  /**
   * Hand-edited: URL template that opens a file in the external editor, with
   * `{path}`, `{line}`, `{column}`. Unset → `PINBENCH_EDITOR_URL`, else VS Code.
   */
  editorUrl?: string
}

const MAX_RECENT_FOLDERS = 8

/**
 * Key for {@link SessionState.folders}. The profile id comes first because its
 * charset is bounded (`/^[a-z0-9][a-z0-9._-]*$/i`, no slash), so a single `/`
 * cleanly separates it from the arbitrary folder path that follows.
 */
export function folderStateKey(dir: string, boardId: string): string {
  return `${boardId}/${dir}`
}

export const DEFAULT_WINDOW: WindowBounds = {
  width: 1360,
  height: 860,
  maximised: false
}

export const DEFAULT_SESSION: SessionState = {
  version: 2,
  window: DEFAULT_WINDOW,
  workspace: DEFAULT_WORKSPACE,
  recentFolders: [],
  lastBoardId: null,
  folders: {},
  acpAutoApprove: false
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((p): p is string => typeof p === 'string').slice(0, MAX_RECENT_FOLDERS)
    : []

/** Keep only well-shaped edit records — a `kind` string is enough; `replayEdits`
 *  drops anything that no longer applies to the board. */
export function normaliseBoardEdits(value: unknown): BoardEdit[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (e): e is BoardEdit =>
      typeof e === 'object' && e !== null && typeof (e as { kind?: unknown }).kind === 'string'
  )
}

function normaliseFolders(value: unknown): Record<string, FolderState> {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, FolderState> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as Partial<FolderState>
    const partConfig: Record<string, PartConfigValue> = {}
    if (entry.partConfig && typeof entry.partConfig === 'object') {
      for (const [k, v] of Object.entries(entry.partConfig)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
          partConfig[k] = v
      }
    }
    out[key] = {
      env: typeof entry.env === 'string' ? entry.env : null,
      partConfig,
      boardEdits: normaliseBoardEdits(entry.boardEdits)
    }
  }
  return out
}

/** Coerce anything on disk into a usable session; never throw at the caller. */
export function normaliseSession(input: unknown): SessionState {
  if (typeof input !== 'object' || input === null) return DEFAULT_SESSION
  const raw = input as Partial<SessionState>
  const window: Partial<WindowBounds> = raw.window ?? {}
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined

  const x = num(window.x)
  const y = num(window.y)
  return {
    version: 2,
    window: {
      ...(x === undefined ? {} : { x }),
      ...(y === undefined ? {} : { y }),
      width: Math.max(640, num(window.width) ?? DEFAULT_WINDOW.width),
      height: Math.max(480, num(window.height) ?? DEFAULT_WINDOW.height),
      maximised: window.maximised === true
    },
    workspace: normaliseWorkspace(raw.workspace),
    recentFolders: stringList(raw.recentFolders),
    lastBoardId: typeof raw.lastBoardId === 'string' ? raw.lastBoardId : null,
    folders: normaliseFolders(raw.folders),
    acpAutoApprove: raw.acpAutoApprove === true,
    ...(typeof raw.editorUrl === 'string' && raw.editorUrl ? { editorUrl: raw.editorUrl } : {})
  }
}

export class SessionStore {
  private state: SessionState
  private readonly file: string

  constructor(file = join(app.getPath('userData'), 'session.json')) {
    this.file = file
    this.state = this.read()
  }

  get(): SessionState {
    return this.state
  }

  setWorkspace(workspace: WorkspaceState): void {
    this.state = { ...this.state, workspace: normaliseWorkspace(workspace) }
    this.write()
  }

  setWindow(bounds: WindowBounds): void {
    this.state = { ...this.state, window: bounds }
    this.write()
  }

  setAcpAutoApprove(enabled: boolean): void {
    this.state = { ...this.state, acpAutoApprove: enabled }
    this.write()
  }

  /** Record `dir` as the most recently opened firmware source folder. */
  addRecentFolder(dir: string): void {
    const recentFolders = [dir, ...this.state.recentFolders.filter((p) => p !== dir)].slice(
      0,
      MAX_RECENT_FOLDERS
    )
    this.state = { ...this.state, recentFolders }
    this.write()
  }

  /** The most recently opened source folder, or null if there is none. */
  lastFolder(): string | null {
    return this.state.recentFolders[0] ?? null
  }

  /** Remember the hardware profile to reopen with. */
  setLastBoard(boardId: string): void {
    this.state = { ...this.state, lastBoardId: boardId }
    this.write()
  }

  /** The remembered env + Inspector config for a (folder, profile) pair. */
  folderState(dir: string, boardId: string): FolderState | null {
    return this.state.folders[folderStateKey(dir, boardId)] ?? null
  }

  /**
   * Merge a patch into the env + Inspector config + canvas edits for a
   * (folder, profile) pair. Only the fields present in `patch` are touched, so
   * an env change cannot wipe a remembered canvas layout and vice versa.
   */
  setFolderState(dir: string, boardId: string, patch: Partial<FolderState>): void {
    const key = folderStateKey(dir, boardId)
    const current: FolderState = this.state.folders[key] ?? {
      env: null,
      partConfig: {},
      boardEdits: []
    }
    this.state = {
      ...this.state,
      folders: { ...this.state.folders, [key]: { ...current, ...patch } }
    }
    this.write()
  }

  private read(): SessionState {
    try {
      if (!existsSync(this.file)) return DEFAULT_SESSION
      return normaliseSession(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch (error) {
      console.warn(`[pinbench] ignoring unreadable session file: ${String(error)}`)
      return DEFAULT_SESSION
    }
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.tmp`
      writeFileSync(temporary, JSON.stringify(this.state, null, 2), 'utf8')
      renameSync(temporary, this.file)
    } catch (error) {
      console.warn(`[pinbench] could not persist session: ${String(error)}`)
    }
  }
}
