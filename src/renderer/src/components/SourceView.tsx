import './source.css'

/**
 * The Source tab exists so the workspace tabs are real and their selection
 * persists. The file tree, the highlighted viewer and the dirty indicators
 * belong to M3, once PinBench actually has a project open.
 */
export function SourceView(): React.JSX.Element {
  return (
    <div className="source" role="tabpanel" aria-label="Source">
      <div className="source__empty">
        <h2 className="source__title">No project open</h2>
        <p className="source__body">
          Opening a firmware project fills this tab with its file tree and a read-only viewer. Until
          then, the Diagram tab is where the board lives.
        </p>
      </div>
    </div>
  )
}
