import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { IGNORED_DIRS, sortNodes } from '../shared/files'
import type { FileNode } from '../shared/files'

const MAX_FILE_BYTES = 2 * 1024 * 1024

/** True when `target` is `root` or lives beneath it — the sandbox boundary. */
export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  if (rel === '') return true
  return !rel.startsWith('..') && !rel.startsWith(`..${sep}`)
}

export class ProjectFiles {
  constructor(private readonly root: string) {}

  private guard(path: string): string {
    const abs = resolve(path)
    if (!isInside(this.root, abs)) {
      throw new Error(`Path escapes project root: ${path}`)
    }
    return abs
  }

  /** Immediate children of `dir` (default: the root), directories first. */
  async readTree(dir?: string): Promise<FileNode[]> {
    const target = dir ? this.guard(dir) : this.root
    const entries = await readdir(target, { withFileTypes: true })
    const nodes: FileNode[] = []
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue
      if (entry.name.startsWith('.') && entry.name !== '.github') continue
      nodes.push({
        name: entry.name,
        path: join(target, entry.name),
        kind: entry.isDirectory() ? 'dir' : 'file'
      })
    }
    return sortNodes(nodes)
  }

  async readFile(path: string): Promise<string> {
    const abs = this.guard(path)
    const info = await stat(abs)
    if (info.size > MAX_FILE_BYTES) {
      return `// PinBench: file is ${(info.size / 1024 / 1024).toFixed(1)} MB — too large to display.`
    }
    return readFile(abs, 'utf8')
  }

  get name(): string {
    return basename(this.root)
  }

  get rootDir(): string {
    return this.root
  }
}
