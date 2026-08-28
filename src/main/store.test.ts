import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SESSION, SessionStore, normaliseSession } from './store'
import { DEFAULT_WORKSPACE } from '../shared/workspace'

const scratch = (): string => join(mkdtempSync(join(tmpdir(), 'pinbench-')), 'session.json')

describe('normaliseSession', () => {
  it('falls back to defaults for junk', () => {
    expect(normaliseSession(undefined)).toEqual(DEFAULT_SESSION)
    expect(normaliseSession([])).toEqual(DEFAULT_SESSION)
  })

  it('refuses a window too small to show the shell', () => {
    const session = normaliseSession({ version: 1, window: { width: 10, height: 10 } })
    expect(session.window.width).toBeGreaterThanOrEqual(640)
    expect(session.window.height).toBeGreaterThanOrEqual(480)
  })

  it('leaves an unpositioned window unpositioned', () => {
    const session = normaliseSession({ version: 1, window: { width: 1000, height: 700 } })
    expect(session.window.x).toBeUndefined()
    expect(session.window.y).toBeUndefined()
  })
})

describe('SessionStore', () => {
  it('starts from the defaults when there is no file', () => {
    expect(new SessionStore(scratch()).get()).toEqual(DEFAULT_SESSION)
  })

  it('persists and reloads the workspace', () => {
    const file = scratch()
    const store = new SessionStore(file)
    store.setWorkspace({ ...DEFAULT_WORKSPACE, dockHeight: 300, workspaceTab: 'source' })

    const reloaded = new SessionStore(file).get()
    expect(reloaded.workspace.dockHeight).toBe(300)
    expect(reloaded.workspace.workspaceTab).toBe('source')
  })

  it('persists window bounds', () => {
    const file = scratch()
    new SessionStore(file).setWindow({ x: 20, y: 40, width: 1200, height: 800, maximised: true })
    expect(new SessionStore(file).get().window).toEqual({
      x: 20,
      y: 40,
      width: 1200,
      height: 800,
      maximised: true
    })
  })

  it('launches from the defaults rather than throwing on a corrupt file', () => {
    const file = scratch()
    writeFileSync(file, '{ this is not json', 'utf8')
    expect(new SessionStore(file).get()).toEqual(DEFAULT_SESSION)
  })

  it('writes valid JSON', () => {
    const file = scratch()
    new SessionStore(file).setWorkspace(DEFAULT_WORKSPACE)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1 })
  })
})
