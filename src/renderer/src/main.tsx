import { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AppInfo, ProjectFileResult, WindowState } from '@shared/ipc'
import type { BoardDefinition } from '@shared/board'
import { App } from './App'
import './styles/base.css'

const INITIAL_WINDOW_STATE: WindowState = { maximised: false, fullScreen: false, focused: true }

/**
 * Everything the shell needs from the main process, resolved before the window
 * paints: the app info, the most recent `.pinbench` project (which names the
 * board), and the validated board definition itself. There is no fallback — if
 * the bridge is missing or the board on disk is malformed, the app is broken
 * and should say so rather than render a plausible-looking lie.
 */
function Root(): React.JSX.Element | null {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [windowState, setWindowState] = useState<WindowState>(INITIAL_WINDOW_STATE)
  const [board, setBoard] = useState<BoardDefinition | null>(null)
  const [availableBoards, setAvailableBoards] = useState<string[]>([])
  const [initialProject, setInitialProject] = useState<ProjectFileResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.pinbench.appInfo().then(setAppInfo)
    void window.pinbench.board.list().then(setAvailableBoards)
    void (async () => {
      const project = await window.pinbench.projectFile.recent()
      setInitialProject(project)
      const result = await window.pinbench.board.load(project?.project.boardId)
      if ('board' in result) setBoard(result.board)
      else setError(result.error)
    })()
    return window.pinbench.window.onStateChange(setWindowState)
  }, [])

  // Switch boards without a restart: the main process reloads the definition
  // and re-feeds the device host; `key={board.id}` on <App> gives a clean
  // remount so no per-board state (selection, verify rows) leaks across.
  const selectBoard = useCallback(
    async (id: string): Promise<void> => {
      if (id === board?.id) return
      const result = await window.pinbench.board.load(id)
      if ('board' in result) setBoard(result.board)
      else setError(result.error)
    },
    [board?.id]
  )

  if (error) {
    return (
      <div style={{ padding: 24, font: '13px/1.5 ui-monospace, monospace', color: '#e5e5e5' }}>
        <strong>PinBench could not load its board definition.</strong>
        <pre style={{ whiteSpace: 'pre-wrap', marginTop: 12 }}>{error}</pre>
      </div>
    )
  }
  if (!appInfo || !board) return null
  return (
    <App
      key={board.id}
      appInfo={appInfo}
      windowState={windowState}
      board={board}
      availableBoards={availableBoards}
      onSelectBoard={selectBoard}
      initialProject={initialProject}
    />
  )
}

const host = document.getElementById('root')
if (!host) throw new Error('renderer root element is missing')

createRoot(host).render(
  <StrictMode>
    <Root />
  </StrictMode>
)
