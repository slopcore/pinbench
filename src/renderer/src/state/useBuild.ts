import { useCallback, useEffect, useRef, useState } from 'react'
import { INITIAL_BUILD_STATUS } from '@shared/build'
import type { BuildOutputLine, BuildStatus } from '@shared/build'
import type { Diagnostic } from '@shared/diagnostics'
import type { BuildRequest } from '@shared/ipc'

const MAX_LOG_LINES = 5_000

export interface BuildHandle {
  status: BuildStatus
  log: BuildOutputLine[]
  diagnostics: Diagnostic[]
  start(request: BuildRequest): void
  cancel(): void
  clean(projectDir: string): void
  clearDiagnostics(): void
}

/**
 * Subscribes to the build pipeline. `onImage` is called once per successful
 * build with the merged flash image, so the caller can boot it — that keeps
 * the board's emulator options in the renderer, where they live until M5.
 */
export function useBuild(onImage: (image: string) => void): BuildHandle {
  const [status, setStatus] = useState<BuildStatus>(INITIAL_BUILD_STATUS)
  const [log, setLog] = useState<BuildOutputLine[]>([])
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([])
  const logRef = useRef<BuildOutputLine[]>([])
  const onImageRef = useRef(onImage)
  useEffect(() => {
    onImageRef.current = onImage
  }, [onImage])

  useEffect(() => {
    return window.pinbench.build.onState((next: BuildStatus) => {
      setStatus(next)
      if (next.state === 'preparing') {
        logRef.current = []
        setLog([])
        setDiagnostics([])
      }
      if (next.state === 'done' && next.image) onImageRef.current(next.image)
    })
  }, [])

  useEffect(() => {
    return window.pinbench.build.onOutput((line: BuildOutputLine) => {
      const lines = logRef.current
      if (line.replace && lines.length > 0) {
        lines[lines.length - 1] = line
      } else {
        lines.push(line)
      }
      if (lines.length > MAX_LOG_LINES) logRef.current = lines.slice(-MAX_LOG_LINES)
      setLog([...logRef.current])
    })
  }, [])

  useEffect(() => {
    return window.pinbench.build.onDiagnostics((rows: Diagnostic[]) => setDiagnostics(rows))
  }, [])

  const start = useCallback((request: BuildRequest) => window.pinbench.build.start(request), [])
  const cancel = useCallback(() => window.pinbench.build.cancel(), [])
  const clean = useCallback((projectDir: string) => window.pinbench.build.clean(projectDir), [])
  const clearDiagnostics = useCallback(() => setDiagnostics([]), [])

  return { status, log, diagnostics, start, cancel, clean, clearDiagnostics }
}
