import type { BuildState } from '@shared/build'
import { buildButtonLabel, isBuildRunning } from '@shared/build'
import type { EmulatorState } from '@shared/emulator'
import type { CanvasTool, GridStyle, WorkspaceState } from '@shared/workspace'
import './toolbar.css'

export interface ToolSpec {
  id: CanvasTool
  label: string
  glyph: string
  /** Present in the design, wired up in M11. */
  enabled: boolean
  hint: string
}

export const CANVAS_TOOLS: ToolSpec[] = [
  { id: 'select', label: 'Select', glyph: '⌖', enabled: true, hint: 'Select parts and nets' },
  { id: 'pan', label: 'Pan', glyph: '✥', enabled: true, hint: 'Drag the canvas' },
  { id: 'net', label: 'Draw net', glyph: '⌁', enabled: false, hint: 'Draw a net between pins' },
  { id: 'probe', label: 'Probe pin', glyph: '◎', enabled: false, hint: 'Probe a pin' }
]

const GRIDS: { id: GridStyle; label: string }[] = [
  { id: 'dot', label: 'Dot' },
  { id: 'line', label: 'Line' },
  { id: 'none', label: 'None' }
]

interface ToolbarProps {
  workspace: WorkspaceState
  buildState: BuildState
  canBuild: boolean
  emulatorState: EmulatorState
  hasFirmware: boolean
  onBuildAndFlash: () => void
  onCancelBuild: () => void
  onFlashUsb: () => void
  onEmulatorStart: () => void
  onEmulatorStop: () => void
  onEmulatorReset: () => void
  onSelectTool: (tool: CanvasTool) => void
  onSelectGrid: (grid: GridStyle) => void
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
  onTogglePanel: (panel: keyof WorkspaceState['panels']) => void
}

export function Toolbar({
  workspace,
  buildState,
  canBuild,
  emulatorState,
  hasFirmware,
  onBuildAndFlash,
  onCancelBuild,
  onFlashUsb,
  onEmulatorStart,
  onEmulatorStop,
  onEmulatorReset,
  onSelectTool,
  onSelectGrid,
  onZoomIn,
  onZoomOut,
  onFit,
  onTogglePanel
}: ToolbarProps): React.JSX.Element {
  const zoomPercent = Math.round(workspace.canvas.viewport.zoom * 100)
  const building = isBuildRunning(buildState)
  const emulatorBusy = emulatorState === 'starting' || emulatorState === 'stopping'
  const canStop = emulatorState === 'running' || emulatorState === 'starting'

  return (
    <div className="toolbar" role="toolbar" aria-label="Workbench">
      <button
        type="button"
        className="toolbar__primary"
        data-building={building || undefined}
        disabled={!canBuild && !building}
        onClick={building ? onCancelBuild : onBuildAndFlash}
        title={building ? 'Cancel build' : 'Build the firmware and boot it'}
      >
        {building ? `${buildButtonLabel(buildState)} — cancel` : buildButtonLabel(buildState)}
      </button>
      <button
        type="button"
        className="toolbar__button toolbar__button--wide"
        disabled={building}
        onClick={onFlashUsb}
        title="Flash the firmware to an attached board over USB (⌘⇧U)"
      >
        Flash USB…
      </button>
      <div className="toolbar__group" role="group" aria-label="Emulator">
        <button
          type="button"
          className="toolbar__button"
          disabled={!hasFirmware || emulatorState === 'running' || emulatorBusy}
          title="Start"
          onClick={onEmulatorStart}
        >
          ▶
        </button>
        <button
          type="button"
          className="toolbar__button"
          disabled={!canStop}
          title="Stop"
          onClick={onEmulatorStop}
        >
          ■
        </button>
        <button
          type="button"
          className="toolbar__button"
          disabled={!hasFirmware || emulatorBusy}
          title="Reset"
          onClick={onEmulatorReset}
        >
          ⟳
        </button>
      </div>

      <div className="toolbar__divider" />

      <div className="toolbar__group" role="group" aria-label="Canvas tools">
        {CANVAS_TOOLS.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className="toolbar__button"
            title={tool.enabled ? tool.hint : `${tool.hint} — not yet implemented`}
            aria-label={tool.label}
            aria-pressed={workspace.canvas.tool === tool.id}
            data-active={workspace.canvas.tool === tool.id || undefined}
            disabled={!tool.enabled}
            onClick={() => onSelectTool(tool.id)}
          >
            {tool.glyph}
          </button>
        ))}
      </div>

      <div className="toolbar__spacer" />

      <div className="toolbar__segmented" role="group" aria-label="Grid">
        {GRIDS.map((grid) => (
          <button
            key={grid.id}
            type="button"
            className="toolbar__segment"
            aria-pressed={workspace.canvas.grid === grid.id}
            data-active={workspace.canvas.grid === grid.id || undefined}
            onClick={() => onSelectGrid(grid.id)}
          >
            {grid.label}
          </button>
        ))}
      </div>

      <div className="toolbar__group" role="group" aria-label="Zoom">
        <button type="button" className="toolbar__button" aria-label="Zoom out" onClick={onZoomOut}>
          −
        </button>
        <span className="toolbar__zoom" aria-live="polite">
          {zoomPercent}%
        </span>
        <button type="button" className="toolbar__button" aria-label="Zoom in" onClick={onZoomIn}>
          +
        </button>
        <button type="button" className="toolbar__button toolbar__button--wide" onClick={onFit}>
          Fit
        </button>
      </div>

      <div className="toolbar__divider" />

      <div className="toolbar__group" role="group" aria-label="Panels">
        <button
          type="button"
          className="toolbar__button toolbar__button--wide"
          aria-pressed={workspace.panels.library}
          data-active={workspace.panels.library || undefined}
          title="Library panel (⌘1)"
          onClick={() => onTogglePanel('library')}
        >
          Library
        </button>
        <button
          type="button"
          className="toolbar__button toolbar__button--wide"
          aria-pressed={workspace.panels.inspector}
          data-active={workspace.panels.inspector || undefined}
          title="Inspector panel (⌘2)"
          onClick={() => onTogglePanel('inspector')}
        >
          Inspector
        </button>
        <button
          type="button"
          className="toolbar__button toolbar__button--wide"
          aria-pressed={workspace.panels.dock}
          data-active={workspace.panels.dock || undefined}
          title="Bottom dock"
          onClick={() => onTogglePanel('dock')}
        >
          Dock
        </button>
      </div>
    </div>
  )
}
