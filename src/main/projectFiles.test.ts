// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isInside, ProjectFiles } from './projectFiles'

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
  writeFileSync(join(root, 'src', 'main.cpp'), '#include "board_pins.h"\nint main() {}\n')
  writeFileSync(join(root, '.pio', 'gen.cpp'), '#ifdef PINBENCH_EMULATED_NET\n#endif\n')

  it('reads a file inside the root, absolute or relative', async () => {
    const files = new ProjectFiles(root)
    expect(await files.readFile(join(root, 'src', 'main.cpp'))).toContain('int main')
    expect(await files.readFile('src/main.cpp')).toContain('int main')
  })

  it('refuses to read outside the root', async () => {
    const files = new ProjectFiles(root)
    await expect(files.readFile('/etc/hosts')).rejects.toThrow(/escapes project root/)
    await expect(files.readFile('../x')).rejects.toThrow(/escapes project root/)
  })

  it('reads a missing file as null', async () => {
    expect(await new ProjectFiles(root).readFileMaybe('include/nope.h')).toBeNull()
  })

  it('finds token references in sources, skipping build output', async () => {
    const found = await new ProjectFiles(root).findReferences([
      'board_pins.h',
      'PINBENCH_EMULATED_NET'
    ])
    expect([...found]).toEqual(['board_pins.h'])
  })
})
