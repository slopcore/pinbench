import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_WORKSPACE, normaliseWorkspace } from '../shared/workspace'
import type { WorkspaceState } from '../shared/workspace'

/**
 * Session state that survives a restart.
 *
 * M5 introduces the `.pinbench` project file, which owns per-project layout.
 * This store keeps only what is not project-specific: where the window was and
 * how the shell was arranged. Writes are atomic — a half-written settings file
 * must never be able to stop the app from launching.
 */

export interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximised: boolean
}

export interface SessionState {
  version: 1
  window: WindowBounds
  workspace: WorkspaceState
  /** Absolute paths of recently opened `.pinbench` files, most recent first. */
  recentProjects: string[]
}

const MAX_RECENT_PROJECTS = 8

export const DEFAULT_WINDOW: WindowBounds = {
  width: 1360,
  height: 860,
  maximised: false
}

export const DEFAULT_SESSION: SessionState = {
  version: 1,
  window: DEFAULT_WINDOW,
  workspace: DEFAULT_WORKSPACE,
  recentProjects: []
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
    version: 1,
    window: {
      ...(x === undefined ? {} : { x }),
      ...(y === undefined ? {} : { y }),
      width: Math.max(640, num(window.width) ?? DEFAULT_WINDOW.width),
      height: Math.max(480, num(window.height) ?? DEFAULT_WINDOW.height),
      maximised: window.maximised === true
    },
    workspace: normaliseWorkspace(raw.workspace),
    recentProjects: Array.isArray(raw.recentProjects)
      ? raw.recentProjects
          .filter((p): p is string => typeof p === 'string')
          .slice(0, MAX_RECENT_PROJECTS)
      : []
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

  /** Record `path` as the most recently opened project, de-duplicated. */
  addRecentProject(path: string): void {
    const recentProjects = [path, ...this.state.recentProjects.filter((p) => p !== path)].slice(
      0,
      MAX_RECENT_PROJECTS
    )
    this.state = { ...this.state, recentProjects }
    this.write()
  }

  /** The most recently opened project path, or null if there is none. */
  lastProject(): string | null {
    return this.state.recentProjects[0] ?? null
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
