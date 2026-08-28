/**
 * A deliberately small syntax highlighter for the read-only Source viewer.
 *
 * Not a parser: a line-at-a-time pass that escapes HTML first, then wraps
 * comments, strings, numbers and a fixed keyword set in spans. Good enough to
 * read C/C++ firmware and INI/JSON config; no dependency, no worker, no CSP
 * concern (the output is escaped text plus PinBench's own `<span>` tags).
 */

const C_KEYWORDS = new Set([
  'alignas',
  'alignof',
  'auto',
  'bool',
  'break',
  'case',
  'char',
  'class',
  'const',
  'constexpr',
  'continue',
  'default',
  'delete',
  'do',
  'double',
  'else',
  'enum',
  'explicit',
  'extern',
  'false',
  'float',
  'for',
  'friend',
  'goto',
  'if',
  'inline',
  'int',
  'long',
  'namespace',
  'new',
  'nullptr',
  'operator',
  'override',
  'private',
  'protected',
  'public',
  'register',
  'return',
  'short',
  'signed',
  'sizeof',
  'static',
  'struct',
  'switch',
  'template',
  'this',
  'throw',
  'true',
  'typedef',
  'typename',
  'union',
  'unsigned',
  'using',
  'virtual',
  'void',
  'volatile',
  'while',
  'uint8_t',
  'uint16_t',
  'uint32_t',
  'uint64_t',
  'int8_t',
  'int16_t',
  'int32_t',
  'size_t'
])

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function highlightCLike(line: string): string {
  // Whole-line comment or preprocessor directive.
  const trimmed = line.trimStart()
  if (trimmed.startsWith('//')) return `<span class="tok-comment">${escapeHtml(line)}</span>`
  if (trimmed.startsWith('#')) return `<span class="tok-pre">${escapeHtml(line)}</span>`

  let out = ''
  let rest = line
  const token =
    /^(\/\/[^\n]*|\/\*.*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d[\w.]*\b|[A-Za-z_]\w*|\s+|.)/

  while (rest.length > 0) {
    const match = token.exec(rest)
    if (!match) break
    const piece = match[0]
    rest = rest.slice(piece.length)

    if (piece.startsWith('//') || piece.startsWith('/*')) {
      out += `<span class="tok-comment">${escapeHtml(piece)}</span>`
    } else if (piece.startsWith('"') || piece.startsWith("'")) {
      out += `<span class="tok-string">${escapeHtml(piece)}</span>`
    } else if (/^\d/.test(piece)) {
      out += `<span class="tok-number">${escapeHtml(piece)}</span>`
    } else if (C_KEYWORDS.has(piece)) {
      out += `<span class="tok-keyword">${escapeHtml(piece)}</span>`
    } else {
      out += escapeHtml(piece)
    }
  }
  return out
}

function highlightIni(line: string): string {
  if (/^\s*[;#]/.test(line)) return `<span class="tok-comment">${escapeHtml(line)}</span>`
  const section = /^\s*(\[[^\]]*\])\s*$/.exec(line)
  if (section) return `<span class="tok-keyword">${escapeHtml(line)}</span>`
  const kv = /^(\s*[\w.-]+\s*)(=)(.*)$/.exec(line)
  if (kv) {
    return `<span class="tok-pre">${escapeHtml(kv[1]!)}</span>=${escapeHtml(kv[3]!)}`
  }
  return escapeHtml(line)
}

export function highlight(line: string, path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.ini') || lower.endsWith('.cfg') || lower.endsWith('.conf')) {
    return highlightIni(line) || '&nbsp;'
  }
  if (/\.(c|cc|cpp|cxx|h|hpp|hxx|ino)$/.test(lower)) {
    return highlightCLike(line) || '&nbsp;'
  }
  return escapeHtml(line) || '&nbsp;'
}
