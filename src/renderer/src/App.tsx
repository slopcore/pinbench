import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { boardTotals, findPart, pickFirmwareEnv } from '@shared/board'
import type { BoardDefinition } from '@shared/board'
import type { CommandId } from '@shared/commands'
import type { AppInfo, LaunchState, WindowState } from '@shared/ipc'
import type { PartConfigValue } from '@shared/partConfig'
import { MAX_ZOOM, MIN_ZOOM, clamp, fitViewport } from '@shared/workspace'
import type { CanvasTool, DockTab, GridStyle, WorkspaceState } from '@shared/workspace'
import { autoArrangeByBus, duplicatePart } from '@shared/boardEdit'
import type { BoardEdit } from '@shared/boardEdit'
import { instantiateCatalogueEntry, type CatalogueEntry } from '@shared/catalogue'
import { Canvas, ZOOM_STEP } from './components/Canvas'
import { Dock } from './components/Dock'
import { HelpSheet } from './components/HelpSheet'
import type { HelpSheetKind } from './components/HelpSheet'
import { Inspector } from './components/Inspector'
import { LibraryPanel } from './components/LibraryPanel'
import { SessionBar } from './components/SessionBar'
import { StatusBar } from './components/StatusBar'
import { TitleBar } from './components/TitleBar'
import { Toolbar } from './components/Toolbar'
import { UsbFlashDialog } from './components/UsbFlashDialog'
import type { UsbFlashMode } from '@shared/usb-flash'
import type { Diagnostic } from '@shared/diagnostics'
import type { FirmwareAction } from '@shared/actions'
import { findingsToDiagnostics, verifyBoard } from '@shared/verify'
import { pinHeaderChanges } from '@shared/codegen'
import { isBuildRunning } from '@shared/build'
import { useMenuCommands } from './state/useCommands'
import { useBoardEditor } from './state/useBoardEditor'
import { useBuild } from './state/useBuild'
import { useAgent } from './state/useAgent'
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
  /** Hardware-profile ids on disk, for the status-bar picker. */
  availableBoards: string[]
  /** Switch to another profile — `Root` reloads the definition and remounts. */
  onSelectBoard: (id: string) => void
  /** Called after "Save hardware profile as…" writes a new `boards/<id>.board.json`. */
  onProfileSaved: (id: string) => void
  /**
   * Launch state from `Root`: the source folder reopened on launch (if any) and
   * that (folder, profile) pair's remembered build env + Inspector config.
   */
  initialFolder: LaunchState
}

export function App({
  appInfo,
  windowState,
  board,
  availableBoards,
  onSelectBoard,
  onProfileSaved,
  initialFolder
}: AppProps): React.JSX.Element {
  const { workspace, dispatch, restored } = useWorkspace()
  const emulator = useEmulator(board.emulator)
  const project = useProject(board.firmware, initialFolder.recentFolders)
  // Env dropdown: narrow to profile-compatible envs by default, with an escape
  // hatch. Resets on profile switch — `Root` remounts <App> on `key={board.id}`.
  const [showAllEnvs, setShowAllEnvs] = useState(false)
  const build = useBuild((image) => emulator.start(image))
  const agent = useAgent()
  const usbFlash = useUsbFlash()
  const [usbFlashOpen, setUsbFlashOpen] = useState(false)
  const [helpSheet, setHelpSheet] = useState<HelpSheetKind | null>(null)
  const devices = useDevices()
  const editor = useBoardEditor(board, initialFolder.boardEdits)
  // The board the canvas, Inspector, Library, Verify and codegen all read —
  // the definition from disk with the session's canvas edits folded in. The
  // emulator and device host stay on the pristine `board` (hardware doesn't
  // move because a card was dragged).
  const editedBoard = editor.board
  const totals = useMemo(() => boardTotals(editedBoard), [editedBoard])
  // The device host loaded its models from the pristine board; adding or
  // removing a part while the emulator runs would leave a model running against
  // a part the canvas no longer shows. Layout drags and net edits are fine.
  const structuralEditsLocked = emulator.state === 'running' || emulator.state === 'starting'

  // Populate the status-bar port label once on mount; the Flash-over-USB dialog
  // refreshes the same list when it opens.
  const refreshPorts = usbFlash.refreshPorts
  useEffect(() => {
    void refreshPorts().catch(() => {
      /* no PlatformIO on this machine — the port label just stays "no port" */
    })
  }, [refreshPorts])
  const activePort = usbFlash.ports[0]?.port ?? null

  // `L` toggles bus labels. Bound here rather than as a menu accelerator so it
  // cannot fire while a text field, the Library filter or a config input holds
  // focus.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'l' && event.key !== 'L') return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return
      }
      dispatch({ type: 'toggleBusLabels' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dispatch])
  const selectedPart = workspace.selectedPartId
    ? findPart(editedBoard, workspace.selectedPartId)
    : undefined

  // Inspector config for the current (folder, profile) pair. Seeded from the
  // launch state `Root` resolved; every change is persisted straight back to
  // `session.json` (there is no document to save).
  const [config, setConfig] = useState<Record<string, PartConfigValue>>(
    () => initialFolder.partConfig
  )
  /** Rows from the last "Verify pin map" (⌘B) run; empty until first run. */
  const [verifyRows, setVerifyRows] = useState<Diagnostic[]>([])

  /**
   * Persist a patch of this (folder, profile) pair's remembered state. Only the
   * given fields are written — persisting the canvas layout must not clobber the
   * remembered env / Inspector config, or vice versa.
   */
  const rememberFolderState = useCallback(
    (patch: {
      env?: string | null
      partConfig?: Record<string, PartConfigValue>
      boardEdits?: BoardEdit[]
    }): void => {
      const dir = project.info?.dir
      if (dir) window.pinbench.project.setFolderState(dir, board.id, patch)
    },
    [project.info?.dir, board.id]
  )

  // What the firmware owes the hardware profile, recomputed by the main process
  // (on open, build, canvas edit, window focus) and mirrored to the IDE.
  const [latestActions, setLatestActions] = useState<FirmwareAction[]>([])
  useEffect(() => window.pinbench.project.onActions(setLatestActions), [])
  useEffect(() => {
    if (project.info) void window.pinbench.project.actions().then(setLatestActions)
  }, [project.info])
  const firmwareActions = project.info ? latestActions : []

  // Code lives in the external IDE: a file:line reference opens there.
  const openInEditor = useCallback((file: string, line?: number, column?: number) => {
    void window.pinbench.project.openInEditor(file, line, column)
  }, [])

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
        message: `Folder: ${project.info.name} · env ${project.env ?? '—'}`
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
    if (emulator.state === 'crashed' && emulator.error) {
      rows.push({ id: 'emu-crash', severity: 'error', message: emulator.error })
    }
    if (emulator.state === 'idle' && !emulator.firmwarePath && !project.info) {
      rows.push({
        id: 'no-firmware',
        severity: 'note',
        message: 'Open a firmware image (⌘⇧O), or open a source folder from File ▸ Open…'
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
    devices.diagnostics,
    verifyRows,
    emulator.state,
    emulator.error,
    emulator.firmwarePath
  ])

  const canBuild =
    project.info !== null && project.env !== null && !isBuildRunning(build.status.state)

  // First error-severity diagnostic, surfaced as a click-through toast floating
  // over the workspace (both tabs). Clicking opens the dock on the tab that
  // carries the evidence — serial for an emulator crash, compiler output otherwise.
  const alert = useMemo((): {
    key: string
    message: string
    extra: number
    target: DockTab
  } | null => {
    const errors = diagnostics.filter((row) => row.severity === 'error')
    // Route by intent, not array position: a stale `verifyRows` error lingers in
    // the list, so picking `errors[0]` would mask a fresh build/emulator failure
    // and point the toast at the wrong dock tab.
    const first =
      errors.find((row) => row.id === 'build-failed') ??
      errors.find((row) => row.id === 'emu-crash') ??
      errors[0]
    if (!first) return null
    return {
      key: `${first.id}:${first.message}`,
      message: first.message,
      extra: errors.length - 1,
      target: first.id === 'emu-crash' ? 'serial' : 'compiler'
    }
  }, [diagnostics])

  // Dismissal is keyed on id+message so a *new* failure (even one reusing the
  // `build-failed` id) re-raises the toast. Reset it the moment the error row
  // drops out — e.g. a rebuild starts — so the next failure is never pre-muted.
  // (Adjusting state during render, the React-sanctioned "reset on prop change"
  // pattern — no effect, no extra commit.)
  const [alertDismissedKey, setAlertDismissedKey] = useState<string | null>(null)
  if (!alert && alertDismissedKey !== null) setAlertDismissedKey(null)

  const dockOnTarget =
    alert !== null &&
    workspace.panels.dock &&
    !workspace.dockCollapsed &&
    workspace.dockTab === alert.target
  const showAlert = alert !== null && alert.key !== alertDismissedKey && !dockOnTarget

  const openAlertTarget = useCallback((): void => {
    if (!alert) return
    dispatch({ type: 'setDockTab', tab: alert.target })
    dispatch({ type: 'setDockCollapsed', collapsed: false })
    // Clicking through is acknowledgement — don't re-pop for a row the user has
    // already opened once (e.g. after they switch the dock to another tab).
    setAlertDismissedKey(alert.key)
  }, [alert, dispatch])

  // A pending agent approval is only shown inside the panel — force the dock
  // open on the Agent tab so it can't block the turn while hidden (the same
  // reveal a build alert does for its tab). `setDockTab` also opens `panels.dock`.
  useEffect(() => {
    if (!agent.permission) return
    dispatch({ type: 'setDockTab', tab: 'agent' })
    dispatch({ type: 'setDockCollapsed', collapsed: false })
  }, [agent.permission, dispatch])

  // Shared tail of "opened a folder": a freshly opened folder has no remembered
  // Inspector state yet. Persist against `result.dir` directly — `project.info`
  // has not re-rendered yet.
  const onFolderOpened = useCallback(
    (result: { dir: string; envs: string[] }) => {
      setConfig({})
      window.pinbench.project.setFolderState(result.dir, board.id, {
        env: pickFirmwareEnv(result.envs, board.firmware),
        partConfig: {}
      })
    },
    [board.id, board.firmware]
  )

  const openFolder = useCallback(async (): Promise<void> => {
    const result = await project.open()
    if (result) onFolderOpened(result)
  }, [project, onFolderOpened])

  const openFolderAt = useCallback(
    async (dir: string): Promise<void> => {
      const result = await project.openAt(dir)
      if ('error' in result) {
        setVerifyRows([
          { id: 'open-folder', severity: 'error', message: `Open firmware failed: ${result.error}` }
        ])
        dispatch({ type: 'setDockTab', tab: 'compiler' })
        return
      }
      onFolderOpened(result)
    },
    [project, onFolderOpened, dispatch]
  )

  const buildAndFlash = useCallback(() => {
    if (!project.info || !project.env) {
      void openFolder()
      return
    }
    build.start({
      projectDir: project.info.dir,
      env: project.env,
      emulator: board.emulator
    })
  }, [board.emulator, build, openFolder, project])

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

  const onConfigChange = useCallback(
    (partId: string, fieldId: string, value: PartConfigValue) => {
      setConfig((previous) => {
        const next = { ...previous, [`${partId}.${fieldId}`]: value }
        rememberFolderState({ env: project.env, partConfig: next })
        return next
      })
    },
    [project.env, rememberFolderState]
  )

  const onSelectEnv = useCallback(
    (next: string): void => {
      project.setEnv(next)
      rememberFolderState({ env: next, partConfig: config })
    },
    [project, config, rememberFolderState]
  )

  // Adopt the folder `Root` reopened on launch, once. `config` is already
  // seeded from `initialFolder.partConfig` in state above.
  const launchApplied = useRef(false)
  useEffect(() => {
    if (launchApplied.current) return
    launchApplied.current = true
    if (initialFolder.folder) {
      project.hydrate(initialFolder.folder, initialFolder.env)
    }
  }, [initialFolder, project])

  // Persist the canvas edit history for this (folder, profile) pair on every
  // change, so a moved/resized/added part survives closing the app. The first
  // run is the hydrated history itself (already on disk) — skip it; `load([])`
  // after "Save profile as…" flows through here too, clearing the stored list
  // so the baked-in edits are not replayed twice next launch.
  const editsHydrated = useRef(false)
  const editsBoardId = useRef(board.id)
  const sawUserEdit = useRef(false)
  useEffect(() => {
    // The first tick is the hydrated history itself. A profile switch that
    // reseeds `useBoardEditor` (its own `base.id` reset, no remount) is a fresh
    // hydration too — forget any pending edit and skip this tick.
    if (editsBoardId.current !== board.id) {
      editsBoardId.current = board.id
      editsHydrated.current = false
      sawUserEdit.current = false
    }
    if (!editsHydrated.current) {
      editsHydrated.current = true
      return
    }
    // Persist real user edits, and a genuine clear (undo back to nothing) — but
    // never an empty list we've never seen a non-empty one behind, which is how
    // a reseed would otherwise overwrite this profile's saved layout.
    if (editor.edits.length > 0) sawUserEdit.current = true
    if (editor.edits.length === 0 && !sawUserEdit.current) return
    rememberFolderState({ boardEdits: editor.edits })
  }, [editor.edits, board.id, rememberFolderState])

  // "Save hardware profile as…" — bake the current canvas edits into a new
  // shareable `boards/<id>.board.json`; `Root` then re-lists and loads it.
  const saveProfileAs = useCallback(async (): Promise<void> => {
    const id = window.prompt('Save hardware profile as (id):', `${board.id}-edited`)?.trim()
    if (!id) return
    const result = await window.pinbench.board.saveProfile(id, editedBoard)
    if ('error' in result) {
      setVerifyRows([
        { id: 'save-profile', severity: 'error', message: `Save profile failed: ${result.error}` }
      ])
      dispatch({ type: 'setDockTab', tab: 'compiler' })
      return
    }
    editor.load([])
    onProfileSaved(result.id)
  }, [board.id, editedBoard, editor, onProfileSaved, dispatch])

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

  const placeCatalogueEntry = useCallback(
    (entry: CatalogueEntry): void => {
      if (structuralEditsLocked) return
      const taken = new Set(editedBoard.parts.map((p) => p.id))
      const part = instantiateCatalogueEntry(entry, taken, {
        x: editedBoard.canvas.width / 2 - 75,
        y: editedBoard.canvas.height / 2 - 55
      })
      editor.apply({ kind: 'addPart', part })
      dispatch({ type: 'selectPart', partId: part.id })
    },
    [dispatch, editedBoard, editor, structuralEditsLocked]
  )

  const runVerify = useCallback((): void => {
    setVerifyRows(findingsToDiagnostics(verifyBoard(editedBoard)))
    dispatch({ type: 'setDockTab', tab: 'compiler' })
  }, [editedBoard, dispatch])

  const importPinout = useCallback(async (): Promise<void> => {
    const text = await window.pinbench.board.importPinHeader()
    if (!text) return
    const declared = new Set(editedBoard.pins.map((p) => p.id))
    const edits = pinHeaderChanges(text, editedBoard)
      .filter((change) => declared.has(change.pin))
      .map((change) => ({
        kind: 'rebindPin' as const,
        partId: editedBoard.parts.find((p) => p.designator === change.designator)!.id,
        signal: change.signal,
        pin: change.pin
      }))
    if (edits.length > 0) editor.applyMany(edits)
  }, [editedBoard, editor])

  const runCommand = useCallback(
    (command: CommandId): void => {
      switch (command) {
        case 'view.toggleLibrary':
          dispatch({ type: 'togglePanel', panel: 'library' })
          break
        case 'view.toggleInspector':
          dispatch({ type: 'togglePanel', panel: 'inspector' })
          break
        case 'view.serialMonitor':
          dispatch({ type: 'setDockTab', tab: 'serial' })
          break
        case 'view.compilerOutput':
          dispatch({ type: 'setDockTab', tab: 'compiler' })
          break
        case 'view.consoleOutput':
          dispatch({ type: 'setDockTab', tab: 'console' })
          break
        case 'view.firmwareActions':
          dispatch({ type: 'setDockTab', tab: 'actions' })
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
        case 'view.busLabels':
          dispatch({ type: 'toggleBusLabels' })
          break
        case 'file.openFirmware':
          emulator.openAndStart()
          break
        case 'file.openProject':
          void openFolder()
          break
        case 'file.saveProfileAs':
          if (!structuralEditsLocked) void saveProfileAs()
          break
        case 'file.exportHeader':
          void window.pinbench.board.exportPinHeader(editor.edits)
          break
        case 'file.importPinout':
          if (!structuralEditsLocked) void importPinout()
          break
        case 'edit.undo':
          if (!structuralEditsLocked) editor.undo()
          break
        case 'edit.redo':
          if (!structuralEditsLocked) editor.redo()
          break
        case 'edit.delete':
          if (workspace.selectedPartId && !structuralEditsLocked) {
            editor.apply({ kind: 'deletePart', partId: workspace.selectedPartId })
            dispatch({ type: 'selectPart', partId: null })
          }
          break
        case 'edit.duplicate':
          if (selectedPart && !structuralEditsLocked) {
            const copy = duplicatePart(selectedPart, editedBoard)
            editor.apply({ kind: 'addPart', part: copy })
            dispatch({ type: 'selectPart', partId: copy.id })
          }
          break
        case 'edit.autoArrange':
          if (!structuralEditsLocked) editor.applyMany(autoArrangeByBus(editedBoard))
          break
        case 'build.buildAndFlash':
          buildAndFlash()
          break
        case 'build.flashUsb':
          setUsbFlashOpen(true)
          break
        case 'build.verifyPinMap':
          runVerify()
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
          setHelpSheet('shortcuts')
          break
        case 'help.about':
          setHelpSheet('about')
          break
        default:
          break
      }
    },
    [
      buildAndFlash,
      build,
      dispatch,
      editedBoard,
      editor,
      emulator,
      fit,
      importPinout,
      openFolder,
      project,
      runVerify,
      saveProfileAs,
      selectedPart,
      structuralEditsLocked,
      workspace.selectedPartId,
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
        case 'view.serialMonitor':
          return workspace.panels.dock && workspace.dockTab === 'serial'
        case 'view.compilerOutput':
          return workspace.panels.dock && workspace.dockTab === 'compiler'
        case 'view.consoleOutput':
          return workspace.panels.dock && workspace.dockTab === 'console'
        case 'view.firmwareActions':
          return workspace.panels.dock && workspace.dockTab === 'actions'
        case 'view.gridDot':
          return workspace.canvas.grid === 'dot'
        case 'view.gridLine':
          return workspace.canvas.grid === 'line'
        case 'view.gridNone':
          return workspace.canvas.grid === 'none'
        case 'view.snapToGrid':
          return workspace.canvas.snapToGrid
        case 'view.busLabels':
          return workspace.canvas.busLabels
        default:
          return false
      }
    },
    [workspace]
  )

  const projectName =
    project.info?.name ??
    (emulator.firmwarePath ? emulator.firmwarePath.split(/[/\\]/).pop() : undefined) ??
    board.name
  // The title-bar dot means "unsaved canvas hardware edits" — the only thing
  // left that isn't persisted the instant it changes.
  const subtitle = editor.edits.length > 0 ? `${projectName} •` : projectName

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
      <SessionBar
        recentFolders={project.recentFolders}
        activeFolder={project.info?.dir ?? null}
        onPickRecent={(dir) => void openFolderAt(dir)}
        onBrowse={() => void openFolder()}
        availableBoards={availableBoards}
        boardId={board.id}
        boardName={board.name}
        onSelectBoard={onSelectBoard}
        envs={project.envs}
        env={project.env}
        onSelectEnv={onSelectEnv}
        {...(board.firmware ? { firmwareHint: board.firmware } : {})}
        showAllEnvs={showAllEnvs}
        onToggleAllEnvs={() => setShowAllEnvs((v) => !v)}
      />
      <Toolbar
        workspace={workspace}
        buildState={build.status.state}
        canBuild={canBuild}
        emulatorState={emulator.state}
        hasFirmware={emulator.firmwarePath !== null}
        onFlashUsb={() => setUsbFlashOpen(true)}
        onVerify={runVerify}
        onPlay={() =>
          canBuild
            ? buildAndFlash()
            : emulator.firmwarePath
              ? emulator.start(emulator.firmwarePath)
              : emulator.openAndStart()
        }
        onStop={() => (isBuildRunning(build.status.state) ? build.cancel() : emulator.stop())}
        onEmulatorReset={emulator.reset}
        onSelectTool={(tool: CanvasTool) => dispatch({ type: 'setTool', tool })}
        onSelectGrid={(grid: GridStyle) => dispatch({ type: 'setGrid', grid })}
        onToggleBusFilter={(kind) => dispatch({ type: 'toggleBusFilter', kind })}
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
            board={editedBoard}
            selectedPartId={workspace.selectedPartId}
            onSelectPart={(partId) => dispatch({ type: 'selectPart', partId })}
            onPlaceCatalogueEntry={placeCatalogueEntry}
          />
        )}

        <main className="workspace">
          <div className="workspace__view">
            <Canvas
              board={editedBoard}
              workspace={workspace}
              onViewport={(viewport) => dispatch({ type: 'setViewport', viewport })}
              onZoomAt={(zoom, origin) => dispatch({ type: 'zoomTo', zoom, origin })}
              onSelectPart={(partId) => dispatch({ type: 'selectPart', partId })}
              onMovePart={(partId, x, y) => editor.apply({ kind: 'moveParty', partId, x, y })}
              onAddNet={(net) => editor.apply({ kind: 'addNet', net })}
              onResizePart={(partId, width, height) =>
                editor.apply({ kind: 'resizeParty', partId, width, height })
              }
              deviceViews={devices.byPart}
              configValues={config}
              onConfigChange={onConfigChange}
              onCommand={(partId, command, args) => devices.sendCommand(partId, command, args)}
              onMeasure={onMeasure}
              ready={restored}
            />

            {showAlert && alert && (
              <div className="workspace__toast" role="alert">
                <button type="button" className="workspace__toast-open" onClick={openAlertTarget}>
                  <span className="workspace__toast-text">
                    {alert.message}
                    {alert.extra > 0 ? ` +${alert.extra} more` : ''}
                  </span>
                  <span className="workspace__toast-cta">
                    Open {alert.target === 'serial' ? 'serial' : 'compiler output'}
                  </span>
                </button>
                <button
                  type="button"
                  className="workspace__toast-dismiss"
                  aria-label="Dismiss"
                  onClick={() => setAlertDismissedKey(alert.key)}
                >
                  ×
                </button>
              </div>
            )}

            {workspace.panels.dock && (
              <Dock
                tab={workspace.dockTab}
                height={workspace.dockHeight}
                collapsed={workspace.dockCollapsed}
                serial={emulator.serial}
                diagnostics={diagnostics}
                firmwareActions={firmwareActions}
                buildLog={build.log}
                buildStatus={build.status}
                emulatorState={emulator.state}
                agent={agent}
                onSelectTab={(tab) => dispatch({ type: 'setDockTab', tab })}
                onResize={(height) => dispatch({ type: 'setDockHeight', height })}
                onToggleCollapsed={() => dispatch({ type: 'toggleDockCollapsed' })}
                onClose={() => dispatch({ type: 'setPanel', panel: 'dock', open: false })}
                onSerialSubmit={emulator.writeSerial}
                onOpenInEditor={openInEditor}
              />
            )}
          </div>
        </main>

        {workspace.panels.inspector && (
          <Inspector
            board={editedBoard}
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
            onOpenInEditor={openInEditor}
          />
        )}
      </div>

      <StatusBar
        board={board}
        env={project.env}
        totals={totals}
        port={activePort}
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

      <HelpSheet
        kind={helpSheet}
        platform={appInfo.platform}
        appInfo={appInfo}
        onClose={() => setHelpSheet(null)}
      />
    </div>
  )
}
