import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileNode } from '@shared/files'
import type { OpenProjectResult } from '@shared/ipc'

export interface ProjectHandle {
  /** null until a source folder is opened. */
  info: OpenProjectResult | null
  /** Build environments from the folder's `platformio.ini` (+ `extra_configs`). */
  envs: string[]
  env: string | null
  setEnv(env: string): void
  /**
   * Prompt for a firmware source folder and adopt it. Resolves to the adopted
   * folder (with its resolved env list) so the caller can persist per-folder
   * state, or null when the dialog was cancelled.
   */
  open(): Promise<OpenProjectResult | null>
  /** Adopt a folder the main process already opened (launch reopen). */
  hydrate(info: OpenProjectResult, env: string | null): Promise<void>
  /** Root-level nodes; directories are filled in lazily on expand. */
  tree: FileNode[]
  expanded: Set<string>
  toggleDir(node: FileNode): void
  childrenOf(path: string): FileNode[] | undefined
  openFile(path: string): Promise<void>
  activeFile: { path: string; content: string } | null
  /** Paths the filesystem watcher has reported changed since they were read. */
  dirty: Set<string>
}

export function useProject(): ProjectHandle {
  const [info, setInfo] = useState<OpenProjectResult | null>(null)
  const [env, setEnvState] = useState<string | null>(null)
  const [tree, setTree] = useState<FileNode[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dirty, setDirty] = useState<Set<string>>(new Set())
  const [activeFile, setActiveFile] = useState<{ path: string; content: string } | null>(null)
  const childrenRef = useRef<Map<string, FileNode[]>>(new Map())

  useEffect(() => {
    return window.pinbench.project.onFileChanged(({ path }) => {
      setDirty((previous) => {
        const next = new Set(previous)
        next.add(path)
        return next
      })
    })
  }, [])

  const open = useCallback(async (): Promise<OpenProjectResult | null> => {
    const result = await window.pinbench.project.open()
    if (!result) return null
    childrenRef.current.clear()
    setInfo(result)
    setEnvState(result.envs[0] ?? null)
    setExpanded(new Set())
    setDirty(new Set())
    setActiveFile(null)
    setTree(await window.pinbench.project.readTree())
    return result
  }, [])

  const hydrate = useCallback(async (nextInfo: OpenProjectResult, nextEnv: string | null) => {
    childrenRef.current.clear()
    setInfo(nextInfo)
    setEnvState(nextEnv ?? nextInfo.envs[0] ?? null)
    setExpanded(new Set())
    setDirty(new Set())
    setActiveFile(null)
    setTree(await window.pinbench.project.readTree())
  }, [])

  const setEnv = useCallback((next: string) => setEnvState(next), [])

  const toggleDir = useCallback((node: FileNode) => {
    if (node.kind !== 'dir') return
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(node.path)) {
        next.delete(node.path)
      } else {
        next.add(node.path)
        if (!childrenRef.current.has(node.path)) {
          void window.pinbench.project.readTree(node.path).then((children) => {
            childrenRef.current.set(node.path, children)
            // Force a re-render now that the children are in the ref.
            setExpanded((current) => new Set(current))
          })
        }
      }
      return next
    })
  }, [])

  const childrenOf = useCallback((path: string) => childrenRef.current.get(path), [])

  const openFile = useCallback(async (path: string) => {
    const content = await window.pinbench.project.readFile(path)
    setActiveFile({ path, content })
    setDirty((previous) => {
      if (!previous.has(path)) return previous
      const next = new Set(previous)
      next.delete(path)
      return next
    })
  }, [])

  return {
    info,
    envs: info?.envs ?? [],
    env,
    setEnv,
    open,
    hydrate,
    tree,
    expanded,
    toggleDir,
    childrenOf,
    openFile,
    activeFile,
    dirty
  }
}
