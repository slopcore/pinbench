import { describe, expect, it } from 'vitest'
import { isAbsolute, resolve } from 'node:path'
import { bySeverity, parseDiagnostics } from './diagnostics'

const opts = { projectRoot: '/proj', resolve, isAbsolute }

describe('parseDiagnostics', () => {
  it('pulls file, line, column, severity and message from a gcc error', () => {
    const text = "src/main.cpp:42:7: error: expected ';' before '}' token"
    const [row] = parseDiagnostics(text, opts)
    expect(row).toMatchObject({
      severity: 'error',
      message: "expected ';' before '}' token",
      file: resolve('/proj', 'src/main.cpp'),
      line: 42,
      column: 7
    })
  })

  it('maps warning and note, and tolerates a missing column', () => {
    const text = ['lib/x.h:10: warning: unused', 'lib/x.h:11: note: declared here'].join('\n')
    const rows = parseDiagnostics(text, opts)
    expect(rows.map((r) => r.severity)).toEqual(['warn', 'note'])
    expect(rows[0]!.column).toBeUndefined()
  })

  it('treats "fatal error" as an error', () => {
    const [row] = parseDiagnostics('src/a.c:1:1: fatal error: no.h: No such file', opts)
    expect(row!.severity).toBe('error')
  })

  it('keeps an already-absolute path as-is', () => {
    const [row] = parseDiagnostics('/abs/b.c:3:1: error: boom', opts)
    expect(row!.file).toBe('/abs/b.c')
  })

  it('ignores lines that are not diagnostics and de-duplicates repeats', () => {
    const text = [
      'Linking .pio/build/esp32s3/firmware.elf',
      'src/main.cpp:5:1: error: boom',
      'src/main.cpp:5:1: error: boom',
      'undefined reference to `foo()`'
    ].join('\n')
    expect(parseDiagnostics(text, opts)).toHaveLength(1)
  })

  it('sorts errors before warnings before notes', () => {
    const rows = [
      { id: '1', severity: 'note' as const, message: 'n' },
      { id: '2', severity: 'error' as const, message: 'e' },
      { id: '3', severity: 'warn' as const, message: 'w' }
    ]
    expect(rows.sort(bySeverity).map((r) => r.severity)).toEqual(['error', 'warn', 'note'])
  })
})
