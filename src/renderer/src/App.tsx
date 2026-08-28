import { useCallback, useMemo, useRef, useState } from 'react'
import { boardTotals, findPart } from '@shared/board'
import type { CommandId } from '@shared/commands'
import type { AppInfo, WindowState } from '@shared/ipc'
import { MAX_ZOOM, MIN_ZOOM, clamp, fitViewport } from '@shared/workspace'
import type { CanvasTool, GridStyle, WorkspaceState } from '@shared/workspace'
import { Canvas, ZOOM_STEP } from './components/Canvas'
import { Dock } from './components/Dock'
import { Inspector } from './components/Inspector'
import { LibraryPanel } from './components/LibraryPanel'
import { SourceView } from './components/SourceView'
import { StatusBar } from './components/StatusBar'
import { TitleBar } from './components/TitleBar'
import { Toolbar } from './components/Toolbar'
import { M9_BOARD } from './fixtures/m9'
import type { Diagnostic } from '@shared/diagnostics'
import { isBuildRunning } from '@shared/build'
import { useMenuCommands } from './state/useCommands'
import { useBuild } from './state/useBuild'
import { useEmulator } from './state/useEmulator'
import { useProject } from './state/useProject'
import { useWorkspace } from './state/useWorkspace'
import './styles/shell.css'

interface AppProps {
  appInfo: AppInfo
  windowState: WindowState
}

export function App({ appInfo, windowState }: AppProps): React.JSX.Element {
  const { workspace, dispatch, restored } = useWorkspace()
  const board = M9_BOARD
  const emulator = useEmulator(board.emulator)
  const project = useProject()
  const build = useBuild((image) => emulator.start(image))
  const totals = useMemo(() => boardTotals(board), [board])
  const selectedPart = workspace.selectedPartId
    ? findPart(board, workspace.selectedPartId)
    : undefined

  const [gotoLine, setGotoLine] = useState<number | undefined>(undefined)

  const openInSource = useCallback(
    (file: string, line?: number) => {
      dispatch({ type: 'setWorkspaceTab', tab: 'source' })
      setGotoLine(line)
      void project.openFile(file)
    },
    [dispatch, project]
  )

  const diagnostics = useMemo((): Diagnostic[] => {
    const rows: Diagnostic[] = [
      {
        id: 'board-loaded',
        severity: 'ok',
        message: `Board definition loaded: ${board.name} (${board.mcu})`
      }
    ]
    if (project.info) {
      rows.push({
        id: 'project-open',
        severity: 'ok',
        message: `Project: ${project.info.name} · env ${project.env ?? '—'}`
      })
    }
    if (build.status.state === 'failed' && build.status.error) {
      rows.push({ id: 'build-failed', severity: 'error', message: build.status.error })
    }
    if (build.status.state === 'done') {
      rows.push({
        id: 'build-done',
        severity: 'ok',
        message: build.status.cached
          ? 'Flash image up to date — booting cached build'
          : 'Build & flash complete — booting'
      })
    }
    rows.push(...build.diagnostics)
    if (emulator.state === 'crashed' && emulator.error) {
      rows.push({ id: 'emu-crash', severity: 'error', message: emulator.error })
    }
    if (emulator.state === 'idle' && !emulator.firmwarePath && !project.info) {
      rows.push({
        id: 'no-firmware',
        severity: 'note',
        message: 'Open a firmware image (⌘⇧O) or a project (⌘O) to begin'
      })
    }
    return rows
  }, [
    board.name,
    board.mcu,
    project.info,
    project.env,
    build.status,
    build.diagnostics,
    emulator.state,
    emulator.error,
    emulator.firmwarePath
  ])

  const canBuild =
    project.info !== null && project.env !== null && !isBuildRunning(build.status.state)

  const buildAndFlash = useCallback(() => {
    if (!project.info || !project.env) {
      void project.open()
      return
    }
    build.start({
      projectDir: project.info.dir,
      env: project.env,
      emulator: board.emulator
    })
  }, [board.emulator, build, project])

  const [config, setConfig] = useState<Record<string, string | number | boolean>>({})
  const onConfigChange = useCallback(
    (partId: string, fieldId: string, value: string | number | boolean) =>
      setConfig((previous) => ({ ...previous, [`${partId}.${fieldId}`]: value })),
    []
  )

  const canvasSize = useRef({ width: 0, height: 0 })
  const onMeasure = useCallback((size: { width: number; height: number }) => {
    canvasSize.current = size
  }, [])

  const fit = useCallback(() => {
    dispatch({ type: 'setViewport', viewport: fitViewport(board.canvas, canvasSize.current) })
  }, [board.canvas, dispatch])

  const zoomBy = useCallback(
    (factor: number) =>
      dispatch({
        type: 'zoomTo',
        zoom: clamp(workspace.canvas.viewport.zoom * factor, MIN_ZOOM, MAX_ZOOM),
        origin: { x: canvasSize.current.width / 2, y: canvasSize.current.height / 2 }
      }),
    [dispatch, workspace.canvas.viewport.zoom]
  )

  const runCommand = useCallback(
    (command: CommandId): void => {
      switch (command) {
        case 'view.toggleLibrary':
          dispatch({ type: 'togglePanel', panel: 'library' })
          break
        case 'view.toggleInspector':
          dispatch({ type: 'togglePanel', panel: 'inspector' })
          break
        case 'view.toggleSource':
          dispatch({
            type: 'setWorkspaceTab',
            tab: workspace.workspaceTab === 'source' ? 'diagram' : 'source'
          })
          break
        case 'view.serialMonitor':
          dispatch({ type: 'setDockTab', tab: 'serial' })
          break
        case 'view.diagnostics':
          dispatch({ type: 'setDockTab', tab: 'diagnostics' })
          break
        case 'view.zoomIn':
          zoomBy(ZOOM_STEP)
          break
        case 'view.zoomOut':
          zoomBy(1 / ZOOM_STEP)
          break
        case 'view.zoomReset':
          dispatch({ type: 'zoomTo', zoom: 1 })
          break
        case 'view.fit':
          fit()
          break
        case 'view.gridDot':
          dispatch({ type: 'setGrid', grid: 'dot' })
          break
        case 'view.gridLine':
          dispatch({ type: 'setGrid', grid: 'line' })
          break
        case 'view.gridNone':
          dispatch({ type: 'setGrid', grid: 'none' })
          break
        case 'view.snapToGrid':
          dispatch({ type: 'toggleSnapToGrid' })
          break
        case 'file.openFirmware':
          emulator.openAndStart()
          break
        case 'file.openProject':
          void project.open()
          break
        case 'build.buildAndFlash':
          buildAndFlash()
          break
        case 'build.clean':
          if (project.info) build.clean(project.info.dir)
          break
        case 'build.start':
          if (emulator.firmwarePath) emulator.start(emulator.firmwarePath)
          else emulator.openAndStart()
          break
        case 'build.stop':
          emulator.stop()
          break
        case 'build.reset':
          emulator.reset()
          break
        case 'help.shortcuts':
        case 'help.about':
          break
        default:
          break
      }
    },
    [buildAndFlash, build, dispatch, emulator, fit, project, workspace.workspaceTab, zoomBy]
  )

  useMenuCommands(runCommand)

  const isChecked = useCallback(
    (command: CommandId): boolean => {
      switch (command) {
        case 'view.toggleLibrary':
          return workspace.panels.library
        case 'view.toggleInspector':
          return workspace.panels.inspector
        case 'view.toggleSource':
          return workspace.workspaceTab === 'source'
        case 'view.serialMonitor':
          return workspace.panels.dock && workspace.dockTab === 'serial'
        case 'view.diagnostics':
          return workspace.panels.dock && workspace.dockTab === 'diagnostics'
        case 'view.gridDot':
          return workspace.canvas.grid === 'dot'
        case 'view.gridLine':
          return workspace.canvas.grid === 'line'
        case 'view.gridNone':
          return workspace.canvas.grid === 'none'
        case 'view.snapToGrid':
          return workspace.canvas.snapToGrid
        default:
          return false
      }
    },
    [workspace]
  )

  const subtitle = project.info
    ? project.info.name
    : emulator.firmwarePath
      ? (emulator.firmwarePath.split('/').pop() ?? 'untitled.pinbench')
      : 'untitled.pinbench'

  return (
    <div className="shell">
      <TitleBar
        platform={appInfo.platform}
        title={board.name}
        subtitle={subtitle}
        windowState={windowState}
        onCommand={runCommand}
        isChecked={isChecked}
      />
      <Toolbar
        workspace={workspace}
        buildState={build.status.state}
        canBuild={canBuild}
        emulatorState={emulator.state}
        hasFirmware={emulator.firmwarePath !== null}
        onBuildAndFlash={buildAndFlash}
        onCancelBuild={build.cancel}
        onEmulatorStart={() =>
          emulator.firmwarePath ? emulator.start(emulator.firmwarePath) : emulator.openAndStart()
        }
        onEmulatorStop={emulator.stop}
        onEmulatorReset={emulator.reset}
        onSelectTool={(tool: CanvasTool) => dispatch({ type: 'setTool', tool })}
        onSelectGrid={(grid: GridStyle) => dispatch({ type: 'setGrid', grid })}
        onZoomIn={() => zoomBy(ZOOM_STEP)}
        onZoomOut={() => zoomBy(1 / ZOOM_STEP)}
        onFit={fit}
        onTogglePanel={(panel: keyof WorkspaceState['panels']) =>
          dispatch({ type: 'togglePanel', panel })
        }
      />

      <div className="shell__body">
        {workspace.panels.library && (
          <LibraryPanel
            board={board}
            selectedPartId={workspace.selectedPartId}
            onSelectPart={(partId) => dispatch({ type: 'selectPart', partId })}
          />
        )}

        <main className="workspace">
          <div className="workspace__tabs" role="tablist" aria-label="Workspace">
            <button
              type="button"
              role="tab"
              className="tab"
              aria-selected={workspace.workspaceTab === 'diagram'}
              data-active={workspace.workspaceTab === 'diagram' || undefined}
              onClick={() => dispatch({ type: 'setWorkspaceTab', tab: 'diagram' })}
            >
              Diagram
            </button>
            <button
              type="button"
              role="tab"
              className="tab"
              aria-selected={workspace.workspaceTab === 'source'}
              data-active={workspace.workspaceTab === 'source' || undefined}
              onClick={() => dispatch({ type: 'setWorkspaceTab', tab: 'source' })}
            >
              Source
            </button>
          </div>

          <div className="workspace__view">
            {workspace.workspaceTab === 'diagram' ? (
              <Canvas
                board={board}
                workspace={workspace}
                onViewport={(viewport) => dispatch({ type: 'setViewport', viewport })}
                onZoomAt={(zoom, origin) => dispatch({ type: 'zoomTo', zoom, origin })}
                onSelectPart={(partId) => dispatch({ type: 'selectPart', partId })}
                onMeasure={onMeasure}
                ready={restored}
              />
            ) : (
              <SourceView
                hasProject={project.info !== null}
                tree={project.tree}
                expanded={project.expanded}
                dirty={project.dirty}
                activeFile={project.activeFile}
                childrenOf={project.childrenOf}
                onToggleDir={project.toggleDir}
                onOpenFile={(path) => {
                  setGotoLine(undefined)
                  void project.openFile(path)
                }}
                {...(gotoLine === undefined ? {} : { gotoLine })}
              />
            )}

            {workspace.panels.dock && (
              <Dock
                tab={workspace.dockTab}
                height={workspace.dockHeight}
                serial={emulator.serial}
                diagnostics={diagnostics}
                buildLog={build.log}
                buildStatus={build.status}
                emulatorState={emulator.state}
                onSelectTab={(tab) => dispatch({ type: 'setDockTab', tab })}
                onResize={(height) => dispatch({ type: 'setDockHeight', height })}
                onClose={() => dispatch({ type: 'setPanel', panel: 'dock', open: false })}
                onSerialSubmit={emulator.writeSerial}
                onOpenSource={openInSource}
              />
            )}
          </div>
        </main>

        {workspace.panels.inspector && (
          <Inspector
            board={board}
            part={selectedPart}
            values={config}
            onConfigChange={onConfigChange}
          />
        )}
      </div>

      <StatusBar
        board={board}
        totals={totals}
        emulator={emulator.state}
        version={appInfo.version}
      />
    </div>
  )
}
