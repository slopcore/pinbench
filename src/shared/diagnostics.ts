/**
 * Diagnostics shown in the bottom dock.
 *
 * The type lived in the renderer through M1–M2 because the only rows were
 * synthesised there. From M3 the compiler is a real source and the rows cross
 * the preload bridge, so the shape belongs in `shared/` next to `serial.ts`.
 */

export type DiagnosticSeverity = 'error' | 'warn' | 'info' | 'note' | 'ok'

export interface Diagnostic {
  id: string
  severity: DiagnosticSeverity
  message: string
  /** Absolute path, resolved from the compiler's project-relative reference. */
  file?: string
  line?: number
  column?: number
}

/** GCC/Clang: `path:line:col: severity: message` (the column is optional). */
const GCC_RE = /^(.+?):(\d+)(?::(\d+))?:\s+(fatal error|error|warning|note):\s+(.*)$/

const SEVERITY_MAP: Record<string, DiagnosticSeverity> = {
  'fatal error': 'error',
  error: 'error',
  warning: 'warn',
  note: 'note'
}

export interface ParseDiagnosticsOptions {
  /** Absolute project directory; relative compiler paths resolve against it. */
  projectRoot: string
  /** Resolver injected so the parser stays free of `node:path` in the browser. */
  resolve: (root: string, file: string) => string
  isAbsolute: (file: string) => boolean
}

/**
 * Pull structured rows out of a `pio run` transcript. Lines that are not a
 * recognised compiler diagnostic are ignored — linker errors and framework
 * noise stay in the raw log rather than being forced into malformed rows.
 */
export function parseDiagnostics(text: string, options: ParseDiagnosticsOptions): Diagnostic[] {
  const rows: Diagnostic[] = []
  const seen = new Set<string>()
  let index = 0

  for (const rawLine of text.split(/\r?\n/)) {
    const match = GCC_RE.exec(rawLine.trim())
    if (!match) continue

    const [, file, lineText, columnText, severityWord, message] = match
    const severity = SEVERITY_MAP[severityWord!] ?? 'warn'
    const absolute = options.isAbsolute(file!) ? file! : options.resolve(options.projectRoot, file!)
    const lineNumber = Number(lineText)
    const columnNumber = columnText ? Number(columnText) : undefined

    const key = `${absolute}:${lineNumber}:${columnNumber ?? ''}:${severity}:${message}`
    if (seen.has(key)) continue
    seen.add(key)

    rows.push({
      id: `diag-${index++}-${lineNumber}`,
      severity,
      message: message!,
      file: absolute,
      line: lineNumber,
      ...(columnNumber === undefined ? {} : { column: columnNumber })
    })
  }

  return rows
}

/** Order rows worst-first so the dock leads with what blocks the build. */
const SEVERITY_RANK: Record<DiagnosticSeverity, number> = {
  error: 0,
  warn: 1,
  note: 2,
  info: 3,
  ok: 4
}

export function bySeverity(a: Diagnostic, b: Diagnostic): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
}
