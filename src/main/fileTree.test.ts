// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isInside, ProjectFiles } from './fileTree'

describe('isInside', () => {
  it('accepts the root itself and any descendant', () => {
    expect(isInside('/proj', '/proj')).toBe(true)
    expect(isInside('/proj', '/proj/src/main.cpp')).toBe(true)
  })

  it('rejects a sibling or a parent-escaping path', () => {
    expect(isInside('/proj', '/other')).toBe(false)
    expect(isInside('/proj', '/proj/../secret')).toBe(false)
  })
})

describe('ProjectFiles', () => {
  const root = mkdtempSync(join(tmpdir(), 'pinbench-tree-'))
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, '.pio'))
  writeFileSync(join(root, 'platformio.ini'), '[env:esp32s3]\n')
  writeFileSync(join(root, 'src', 'main.cpp'), 'int main() {}\n')

  it('lists directories before files and hides .pio', async () => {
    const files = new ProjectFiles(root)
    const names = (await files.readTree()).map((n) => `${n.kind}:${n.name}`)
    expect(names).toEqual(['dir:src', 'file:platformio.ini'])
  })

  it('reads a file inside the root', async () => {
    const files = new ProjectFiles(root)
    expect(await files.readFile(join(root, 'src', 'main.cpp'))).toContain('int main')
  })

  it('refuses to read outside the root', async () => {
    const files = new ProjectFiles(root)
    await expect(files.readFile('/etc/hosts')).rejects.toThrow(/escapes project root/)
  })
})
