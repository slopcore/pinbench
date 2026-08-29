import { StrictMode, useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AppInfo, LaunchState, WindowState } from '@shared/ipc'
import type { BoardDefinition } from '@shared/board'
import { App } from './App'
import './styles/base.css'

const INITIAL_WINDOW_STATE: WindowState = { maximised: false, fullScreen: false, focused: true }

/**
 * Everything the shell needs from the main process, resolved before the window
 * paints: the app info, the launch state (last hardware profile + last source
 * folder + that pair's remembered env / Inspector config), and the validated
 * board definition. There is no fallback — if the bridge is missing or the
 * board on disk is malformed, the app is broken and should say so rather than
 * render a plausible-looking lie.
 */
function Root(): React.JSX.Element | null {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [windowState, setWindowState] = useState<WindowState>(INITIAL_WINDOW_STATE)
  const [board, setBoard] = useState<BoardDefinition | null>(null)
  const [availableBoards, setAvailableBoards] = useState<string[]>([])
  const [launch, setLaunch] = useState<LaunchState | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Bumped to force a clean <App> remount when the loaded profile is saved over
  // (a new id changes `board.id` and remounts on its own; an overwrite does not).
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    void window.pinbench.appInfo().then(setAppInfo)
    void window.pinbench.board.list().then(setAvailableBoards)
    void (async () => {
      const state = await window.pinbench.launchState()
      setLaunch(state)
      const result = await window.pinbench.board.load(state.lastBoardId ?? undefined)
      if ('board' in result) setBoard(result.board)
      else setError(result.error)
    })()
    return window.pinbench.window.onStateChange(setWindowState)
  }, [])

  const applyBoard = useCallback(async (id: string, remember: boolean): Promise<void> => {
    const result = await window.pinbench.board.load(id)
    if ('board' in result) {
      setBoard(result.board)
      if (remember) window.pinbench.board.remember(id)
    } else {
      setError(result.error)
    }
  }, [])

  // Switch hardware profiles without a restart: the main process reloads the
  // definition and re-feeds the device host; `key` on <App> gives a clean
  // remount so no per-profile state (selection, verify rows, canvas edits)
  // leaks across.
  const selectBoard = useCallback(
    (id: string): Promise<void> => {
      if (id === board?.id) return Promise.resolve()
      return applyBoard(id, true)
    },
    [board?.id, applyBoard]
  )

  // "Save hardware profile as…" wrote boards/<id>.board.json — re-list the
  // picker and load the saved profile (forcing a remount so the canvas resets
  // from the freshly-baked file).
  const onProfileSaved = useCallback(
    (id: string): void => {
      void window.pinbench.board.list().then(setAvailableBoards)
      setNonce((n) => n + 1)
      void applyBoard(id, true)
    },
    [applyBoard]
  )

  if (error) {
    return (
      <div style={{ padding: 24, font: '13px/1.5 ui-monospace, monospace', color: '#e5e5e5' }}>
        <strong>PinBench could not load its board definition.</strong>
        <pre style={{ whiteSpace: 'pre-wrap', marginTop: 12 }}>{error}</pre>
      </div>
    )
  }
  if (!appInfo || !board || !launch) return null
  return (
    <App
      key={`${board.id}#${nonce}`}
      appInfo={appInfo}
      windowState={windowState}
      board={board}
      availableBoards={availableBoards}
      onSelectBoard={selectBoard}
      onProfileSaved={onProfileSaved}
      initialFolder={launch}
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
