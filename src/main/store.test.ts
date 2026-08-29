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

  it('keeps only string entries from recentFolders', () => {
    const session = normaliseSession({
      version: 2,
      window: { width: 1000, height: 700 },
      recentFolders: ['/repo/a', 42, null, '/repo/b']
    })
    expect(session.recentFolders).toEqual(['/repo/a', '/repo/b'])
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
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 2 })
  })

  it('records recent source folders most-recent-first, de-duplicated and capped', () => {
    const file = scratch()
    const store = new SessionStore(file)
    for (const d of ['/repo/MeshCore', '/repo/other', '/repo/MeshCore']) store.addRecentFolder(d)
    expect(store.lastFolder()).toBe('/repo/MeshCore')

    const reloaded = new SessionStore(file)
    expect(reloaded.get().recentFolders).toEqual(['/repo/MeshCore', '/repo/other'])
    for (let i = 0; i < 12; i++) reloaded.addRecentFolder(`/repo/p${i}`)
    expect(reloaded.get().recentFolders).toHaveLength(8)
  })

  it('persists the last hardware profile and reloads it', () => {
    const file = scratch()
    new SessionStore(file).setLastBoard('heltec-wireless-paper-v1.1')
    expect(new SessionStore(file).get().lastBoardId).toBe('heltec-wireless-paper-v1.1')
  })

  it('remembers env + Inspector config per (folder, profile) pair', () => {
    const file = scratch()
    const store = new SessionStore(file)
    store.setFolderState('/repo/MeshCore', 'heltec-wireless-paper-v1.1', {
      env: 'Heltec_Wireless_Paper_repeater',
      partConfig: { 'u3.refresh': 'Full' }
    })
    // A different profile in the same folder is a separate slot.
    expect(store.folderState('/repo/MeshCore', 'thinknode-m9-v1.0')).toBeNull()

    const reloaded = new SessionStore(file)
    expect(reloaded.folderState('/repo/MeshCore', 'heltec-wireless-paper-v1.1')).toEqual({
      env: 'Heltec_Wireless_Paper_repeater',
      partConfig: { 'u3.refresh': 'Full' }
    })
  })

  it('normalises a v1 session.json without losing the window or workspace', () => {
    const file = scratch()
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        window: { width: 1200, height: 800, maximised: false },
        workspace: { ...DEFAULT_WORKSPACE, dockHeight: 250 },
        recentProjects: ['/old.pinbench']
      }),
      'utf8'
    )
    const state = new SessionStore(file).get()
    expect(state.version).toBe(2)
    expect(state.window.width).toBe(1200)
    expect(state.workspace.dockHeight).toBe(250)
    expect(state.recentFolders).toEqual([])
    expect(state.lastBoardId).toBeNull()
    expect(state.folders).toEqual({})
  })
})
