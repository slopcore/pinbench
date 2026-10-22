import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'

const MAX_FILE_BYTES = 2 * 1024 * 1024

/** Directory names never worth scanning in a firmware project. */
const IGNORED_DIRS = new Set(['.git', '.pio', '.pinbench', 'node_modules', '.vscode', '.svn'])

/** Source files the reference scan reads. */
const SOURCE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hh',
  '.hpp',
  '.ino',
  '.ini'
])

/** True when `target` is `root` or lives beneath it — the sandbox boundary. */
export function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  if (rel === '') return true
  return !rel.startsWith('..') && !rel.startsWith(`..${sep}`)
}

/**
 * Read-only access to the opened firmware folder. PinBench never writes the
 * firmware source — code lives in the external IDE — so there is no write path.
 */
export class ProjectFiles {
  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  private guard(path: string): string {
    const abs = resolve(this.root, path)
    if (!isInside(this.root, abs)) {
      throw new Error(`Path escapes project root: ${path}`)
    }
    return abs
  }

  /** A file inside the project; relative paths resolve against the root. */
  async readFile(path: string): Promise<string> {
    const abs = this.guard(path)
    const info = await stat(abs)
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(`${path} is ${(info.size / 1024 / 1024).toFixed(1)} MB — too large to read`)
    }
    return readFile(abs, 'utf8')
  }

  /** Like {@link readFile}, but null when the file does not exist. */
  async readFileMaybe(path: string): Promise<string | null> {
    try {
      return await this.readFile(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  /**
   * Which of `tokens` appear anywhere in the project's C/C++ sources and
   * `platformio.ini` files. Build output and VCS directories are skipped.
   */
  async findReferences(tokens: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>()
    const walk = async (dir: string): Promise<void> => {
      if (found.size === tokens.length) return
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return // unreadable directory — skip it rather than fail the scan
      }
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) await walk(path)
          continue
        }
        if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
        let text: string
        try {
          if ((await stat(path)).size > MAX_FILE_BYTES) continue
          text = await readFile(path, 'utf8')
        } catch {
          continue
        }
        for (const token of tokens) if (text.includes(token)) found.add(token)
        if (found.size === tokens.length) return
      }
    }
    await walk(this.root)
    return found
  }

  get name(): string {
    return basename(this.root)
  }

  get rootDir(): string {
    return this.root
  }
}
