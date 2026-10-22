import { useCallback, useState } from 'react'
import { pickFirmwareEnv } from '@shared/board'
import type { FirmwareHint } from '@shared/board'
import type { OpenProjectAtResult, OpenProjectResult } from '@shared/ipc'

export interface ProjectHandle {
  /** null until a source folder is opened. */
  info: OpenProjectResult | null
  /** Build environments from the folder's `platformio.ini` (+ `extra_configs`). */
  envs: string[]
  env: string | null
  setEnv(env: string): void
  /** Recently opened source folders (absolute paths), most recent first. */
  recentFolders: string[]
  /**
   * Prompt for a firmware source folder and adopt it. Resolves to the adopted
   * folder (with its resolved env list) so the caller can persist per-folder
   * state, or null when the dialog was cancelled.
   */
  open(): Promise<OpenProjectResult | null>
  /**
   * Adopt a known folder by path — the session bar's recents dropdown. Resolves
   * to the adopted folder, or `{ error }` when the path is gone / has no
   * `platformio.ini` / a build is running (the caller surfaces it).
   */
  openAt(dir: string): Promise<OpenProjectAtResult>
  /** Adopt a folder the main process already opened (launch reopen). */
  hydrate(info: OpenProjectResult, env: string | null): void
}

/**
 * `firmwareHint` (the active board's `firmware` block) picks the build env for a
 * freshly opened or reopened folder. It must be referentially stable across
 * renders — it lands in `open`/`hydrate`'s `useCallback` deps. `Root` remounts
 * this hook on every profile switch, so `board.firmware` from one `parseBoard`
 * is stable for the hook's lifetime. `initialRecents` seeds the recents
 * dropdown from launch state; `open`/`openAt` keep it current thereafter.
 */
export function useProject(
  firmwareHint?: FirmwareHint,
  initialRecents: string[] = []
): ProjectHandle {
  const [info, setInfo] = useState<OpenProjectResult | null>(null)
  const [env, setEnvState] = useState<string | null>(null)
  const [recentFolders, setRecentFolders] = useState<string[]>(initialRecents)

  // Shared tail of open / openAt: swap in the adopted folder. Env is the caller's to set (open vs. launch differ).
  const adopt = useCallback(
    (result: OpenProjectResult): void => {
      setInfo(result)
      setEnvState(pickFirmwareEnv(result.envs, firmwareHint))
      setRecentFolders((prev) => [result.dir, ...prev.filter((p) => p !== result.dir)])
    },
    [firmwareHint]
  )

  const open = useCallback(async (): Promise<OpenProjectResult | null> => {
    const result = await window.pinbench.project.open()
    if (!result) return null
    adopt(result)
    return result
  }, [adopt])

  const openAt = useCallback(
    async (dir: string): Promise<OpenProjectAtResult> => {
      const result = await window.pinbench.project.openAt(dir)
      if (!('error' in result)) adopt(result)
      return result
    },
    [adopt]
  )

  const hydrate = useCallback(
    (nextInfo: OpenProjectResult, nextEnv: string | null): void => {
      setInfo(nextInfo)
      // A remembered env only wins if the folder still defines it; otherwise
      // (null, or stale after a profile switch) fall back to the board's hint.
      const remembered =
        nextEnv && nextInfo.envs.includes(nextEnv)
          ? nextEnv
          : pickFirmwareEnv(nextInfo.envs, firmwareHint)
      setEnvState(remembered)
      setRecentFolders((prev) => [nextInfo.dir, ...prev.filter((p) => p !== nextInfo.dir)])
    },
    [firmwareHint]
  )

  const setEnv = useCallback((next: string) => setEnvState(next), [])

  return {
    info,
    envs: info?.envs ?? [],
    env,
    setEnv,
    recentFolders,
    open,
    openAt,
    hydrate
  }
}
