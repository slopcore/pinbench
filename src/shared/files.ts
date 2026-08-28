/**
 * The read-only project tree the Source tab renders. The renderer is
 * sandboxed, so every entry here was produced in the main process and every
 * path was checked to fall inside the opened project root before it crossed
 * the bridge.
 */

export interface FileNode {
  name: string
  /** Absolute path. */
  path: string
  kind: 'file' | 'dir'
  /** Directories only: children, when they have been read. */
  children?: FileNode[]
}

/** Directory names never worth showing in a firmware project's tree. */
export const IGNORED_DIRS = new Set(['.git', '.pio', 'node_modules', '.vscode', '.svn'])

export function sortNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}
