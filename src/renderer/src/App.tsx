import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { boardTotals, findPart } from '@shared/board'
import type { BoardDefinition } from '@shared/board'
import type { CommandId } from '@shared/commands'
import type { AppInfo, ProjectFileResult, WindowState } from '@shared/ipc'
import type { PartConfigValue, ProjectFile } from '@shared/project'
import { DEFAULT_PROJECT } from '@shared/project'
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
import { UsbFlashDialog } from './components/UsbFlashDialog'
import type { UsbFlashMode } from '@shared/usb-flash'
import type { Diagnostic } from '@shared/diagnostics'
import { findingsToDiagnostics, verifyBoard } from '@shared/verify'
import { isBuildRunning } from '@shared/build'
import { useMenuCommands } from './state/useCommands'
import { useBuild } from './state/useBuild'
import { useUsbFlash } from './state/useUsbFlash'
import { useDevices } from './state/useDevices'
import { useEmulator } from './state/useEmulator'
import { useProject } from './state/useProject'
import { useWorkspace } from './state/useWorkspace'
import './styles/shell.css'

interface AppProps {
  appInfo: AppInfo
  windowState: WindowState
  board: BoardDefinition
  /** Board ids on disk, for the status-bar picker. */
  availableBoards: string[]
  /** Switch to another board — `Root` reloads the definition and remounts. */
  onSelectBoard: (id: string) => void
  /** The `.pinbench` file reopened on launch, if any — resolved by `Root`. */
  initialProject: ProjectFileResult | null
}

export function App({
  appInfo,
  windowState,
  board,
  availableBoards,
  onSelectBoard,
  initialProject
}: AppProps): React.JSX.Element {
  const { workspace, dispatch, restored } = useWorkspace()
  const emulator = useEmulator(board.emulator)
  const project = useProject()
  const build = useBuild((image) => emulator.start(image))
  const usbFlash = useUsbFlash()
  const [usbFlashOpen, setUsbFlashOpen] = useState(false)
  const devices = useDevices()
  const totals = useMemo(() => boardTotals(board), [board])
  const selectedPart = workspace.selectedPartId
    ? findPart(board, workspace.selectedPartId)
    : undefined

  const [gotoLine, setGotoLine] = useState<number | undefined>(undefined)

  // The `.pinbench` document: board, firmware project, and per-part config.
  // Seeded from the file `Root` reopened; its PlatformIO project and selection
  // are applied in the mount effect below.
  const [projectPath, setProjectPath] = useState<string | null>(initialProject?.path ?? null)
  const [config, setConfig] = useState<Record<string, PartConfigValue>>(
    () => initialProject?.project.partConfig ?? {}
  )
  const [projectDirty, setProjectDirty] = useState(false)
  /** Set when an opened `.pinbench` names a board other than the loaded one (M13). */
  const [otherBoardId, setOtherBoardId] = useState<string | null>(null)
  /** Rows from the last "Verify pin map" (⌘B) run; empty until first run. */
  const [verifyRows, setVerifyRows] = useState<Diagnostic[]>([])

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
    rows.push(...devices.diagnostics)
    rows.push(...verifyRows)
    if (otherBoardId) {
      rows.push({
        id: 'other-board',
        severity: 'warn',
        message: `This project targets board "${otherBoardId}" — pick it in the status-bar board selector to switch`
      })
    }
    if (emulator.state === 'crashed' && emulator.error) {
      rows.push({ id: 'emu-crash', severity: 'error', message: emulator.error })
    }
    if (emulator.state === 'idle' && !emulator.firmwarePath && !project.info) {
      rows.push({
        id: 'no-firmware',
        severity: 'note',
        message: 'Open a firmware image (⌘⇧O), or attach a project checkout from Build & flash'
      })
    }
    return rows
  }, [
    board.name,
    otherBoardId,
    board.mcu,
    project.info,
    project.env,
    build.status,
    build.diagnostics,
    devices.diagnostics,
    verifyRows,
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

  const startUsbFlash = useCallback(
    (port: string, mode: UsbFlashMode) => {
      if (!project.info || !project.env) return
      usbFlash.start({
        projectDir: project.info.dir,
        env: project.env,
        port,
        mode,
        ...(board.emulator.machine ? { chip: board.emulator.machine } : {})
      })
    },
    [board.emulator.machine, project.env, project.info, usbFlash]
  )

  const onConfigChange = useCallback((partId: string, fieldId: string, value: PartConfigValue) => {
    setConfig((previous) => ({ ...previous, [`${partId}.${fieldId}`]: value }))
    setProjectDirty(true)
  }, [])

  const applyProjectFile = useCallback(
    (loaded: ProjectFileResult): void => {
      setProjectPath(loaded.path)
      setConfig(loaded.project.partConfig)
      setProjectDirty(false)
      setOtherBoardId(
        loaded.project.boardId && loaded.project.boardId !== board.id
          ? loaded.project.boardId
          : null
      )
      dispatch({ type: 'selectPart', partId: loaded.project.selectedPartId })
      if (loaded.pio) void project.hydrate(loaded.pio, loaded.project.env)
    },
    [board.id, dispatch, project]
  )

  // Apply the launch project's PlatformIO checkout and selection once. Its
  // path and per-part config are already seeded into state above.
  const launchApplied = useRef(false)
  useEffect(() => {
    if (launchApplied.current || !initialProject) return
    launchApplied.current = true
    dispatch({ type: 'selectPart', partId: initialProject.project.selectedPartId })
    if (initialProject.pio) {
      void project.hydrate(initialProject.pio, initialProject.project.env)
    }
  }, [initialProject, dispatch, project])

  const currentProjectFile = useCallback(
    (): ProjectFile => ({
      ...DEFAULT_PROJECT,
      boardId: board.id,
      platformioDir: project.info?.dir ?? null,
      env: project.env,
      partConfig: config,
      selectedPartId: workspace.selectedPartId
    }),
    [board.id, config, project.env, project.info, workspace.selectedPartId]
  )

  const saveProject = useCallback(
    async (forceDialog: boolean): Promise<void> => {
      const result = await window.pinbench.projectFile.save(
        forceDialog ? null : projectPath,
        currentProjectFile()
      )
      if ('path' in result) {
        setProjectPath(result.path)
        setProjectDirty(false)
      }
    },
    [currentProjectFile, projectPath]
  )

  const openProjectFile = useCallback(async (): Promise<void> => {
    const loaded = await window.pinbench.projectFile.open()
    if (loaded) applyProjectFile(loaded)
  }, [applyProjectFile])

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
          void openProjectFile()
          break
        case 'file.save':
          void saveProject(false)
          break
        case 'file.saveAs':
          void saveProject(true)
          break
        case 'build.buildAndFlash':
          buildAndFlash()
          break
        case 'build.flashUsb':
          setUsbFlashOpen(true)
          break
        case 'build.verifyPinMap':
          setVerifyRows(findingsToDiagnostics(verifyBoard(board)))
          dispatch({ type: 'setDockTab', tab: 'diagnostics' })
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
    [
      board,
      buildAndFlash,
      build,
      dispatch,
      emulator,
      fit,
      openProjectFile,
      project,
      saveProject,
      workspace.workspaceTab,
      zoomBy
    ]
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

  const projectName =
    projectPath?.split(/[/\\]/).pop() ??
    project.info?.name ??
    (emulator.firmwarePath ? emulator.firmwarePath.split(/[/\\]/).pop() : undefined) ??
    'untitled.pinbench'
  const subtitle = projectDirty ? `${projectName} •` : projectName

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
        onFlashUsb={() => setUsbFlashOpen(true)}
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
            device={selectedPart ? devices.byPart.get(selectedPart.id) : undefined}
            onSetLevel={
              selectedPart
                ? (signal: string, level: 0 | 1) =>
                    devices.setSignal(selectedPart.id, signal, level)
                : undefined
            }
            onCommand={
              selectedPart
                ? (command: string, args?: Record<string, unknown>) =>
                    devices.sendCommand(selectedPart.id, command, args)
                : undefined
            }
          />
        )}
      </div>

      <StatusBar
        board={board}
        availableBoards={availableBoards}
        onSelectBoard={onSelectBoard}
        totals={totals}
        emulator={emulator.state}
        version={appInfo.version}
      />

      <UsbFlashDialog
        open={usbFlashOpen}
        status={usbFlash.status}
        log={usbFlash.log}
        ports={usbFlash.ports}
        projectName={project.info?.name ?? null}
        env={project.env}
        onRefreshPorts={usbFlash.refreshPorts}
        onFlash={startUsbFlash}
        onCancel={usbFlash.cancel}
        onClose={() => {
          setUsbFlashOpen(false)
          usbFlash.reset()
        }}
      />
    </div>
  )
}
