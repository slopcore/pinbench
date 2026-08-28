import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import {
  DEFAULT_WORKSPACE,
  workspaceReducer,
  type WorkspaceAction,
  type WorkspaceState
} from '@shared/workspace'

/**
 * Workspace state, restored from the main process on mount and written back
 * (debounced) on every change. The renderer never touches the filesystem: the
 * whole round trip goes over the preload bridge.
 */
export function useWorkspace(): {
  workspace: WorkspaceState
  dispatch: (action: WorkspaceAction) => void
  restored: boolean
} {
  const [workspace, dispatch] = useReducer(workspaceReducer, DEFAULT_WORKSPACE)
  const [restored, setRestored] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    window.pinbench.workspace
      .load()
      .then((saved) => {
        if (!cancelled) dispatch({ type: 'replace', state: saved })
      })
      .catch((error: unknown) => {
        console.warn('[pinbench] falling back to the default layout:', error)
      })
      .finally(() => {
        if (!cancelled) setRestored(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    // Do not write the defaults back over the saved layout before it arrives.
    if (!restored) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => window.pinbench.workspace.save(workspace), 200)
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [workspace, restored])

  // Flush the pending write when the window goes away, so a layout change made
  // a fraction of a second before quitting still survives the restart.
  useEffect(() => {
    const flush = (): void => window.pinbench.workspace.save(workspace)
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [workspace])

  const stableDispatch = useCallback((action: WorkspaceAction) => dispatch(action), [])

  return { workspace, dispatch: stableDispatch, restored }
}
