import { useMemo } from 'react'
import type { FileNode } from '@shared/files'
import { highlight } from './highlight'
import './source.css'

interface SourceViewProps {
  hasProject: boolean
  tree: FileNode[]
  expanded: Set<string>
  dirty: Set<string>
  activeFile: { path: string; content: string } | null
  childrenOf: (path: string) => FileNode[] | undefined
  onToggleDir: (node: FileNode) => void
  onOpenFile: (path: string) => void
  /** 1-based line to scroll to, set when a diagnostic was clicked. */
  gotoLine?: number
}

function TreeRow({
  node,
  depth,
  expanded,
  dirty,
  activePath,
  childrenOf,
  onToggleDir,
  onOpenFile
}: {
  node: FileNode
  depth: number
  expanded: Set<string>
  dirty: Set<string>
  activePath: string | undefined
  childrenOf: (path: string) => FileNode[] | undefined
  onToggleDir: (node: FileNode) => void
  onOpenFile: (path: string) => void
}): React.JSX.Element {
  const isOpen = expanded.has(node.path)
  const children = isOpen ? childrenOf(node.path) : undefined

  return (
    <>
      <button
        type="button"
        className="filetree__row"
        data-kind={node.kind}
        data-active={activePath === node.path || undefined}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => (node.kind === 'dir' ? onToggleDir(node) : onOpenFile(node.path))}
      >
        <span className="filetree__twist">{node.kind === 'dir' ? (isOpen ? '▾' : '▸') : ''}</span>
        <span className="filetree__name">{node.name}</span>
        {dirty.has(node.path) && (
          <span className="filetree__dirty" aria-label="modified">
            ●
          </span>
        )}
      </button>
      {isOpen &&
        (children ?? []).map((child) => (
          <TreeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            dirty={dirty}
            activePath={activePath}
            childrenOf={childrenOf}
            onToggleDir={onToggleDir}
            onOpenFile={onOpenFile}
          />
        ))}
    </>
  )
}

export function SourceView({
  hasProject,
  tree,
  expanded,
  dirty,
  activeFile,
  childrenOf,
  onToggleDir,
  onOpenFile,
  gotoLine
}: SourceViewProps): React.JSX.Element {
  const lines = useMemo(() => (activeFile ? activeFile.content.split('\n') : []), [activeFile])

  if (!hasProject) {
    return (
      <div className="source source--empty" role="tabpanel" aria-label="Source">
        <div className="source__empty">
          <h2 className="source__title">No project open</h2>
          <p className="source__body">
            File ▸ Open project… points PinBench at a PlatformIO checkout. Its file tree and a
            read-only viewer fill this tab, and Build &amp; flash compiles it.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="source" role="tabpanel" aria-label="Source">
      <nav className="filetree" aria-label="Project files">
        {tree.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            expanded={expanded}
            dirty={dirty}
            activePath={activeFile?.path}
            childrenOf={childrenOf}
            onToggleDir={onToggleDir}
            onOpenFile={onOpenFile}
          />
        ))}
      </nav>
      <div className="sourceview">
        {activeFile ? (
          <>
            <div className="sourceview__path">
              {activeFile.path}
              {dirty.has(activeFile.path) && ' — changed on disk'}
            </div>
            <ol className="sourceview__code">
              {lines.map((line, index) => (
                <li
                  key={index}
                  className="sourceview__line"
                  data-goto={gotoLine === index + 1 || undefined}
                  ref={
                    gotoLine === index + 1
                      ? (el) => el?.scrollIntoView({ block: 'center' })
                      : undefined
                  }
                >
                  <span className="sourceview__ln">{index + 1}</span>
                  <span
                    className="sourceview__text"
                    dangerouslySetInnerHTML={{ __html: highlight(line, activeFile.path) }}
                  />
                </li>
              ))}
            </ol>
          </>
        ) : (
          <div className="sourceview__hint">Select a file to view it.</div>
        )}
      </div>
    </div>
  )
}
