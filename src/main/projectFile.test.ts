import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT } from '../shared/project'
import { readProjectFile, writeProjectFile } from './projectFile'

const scratch = (): string => mkdtempSync(join(tmpdir(), 'pinbench-project-'))

describe('project file round-trip', () => {
  it('writes then reads back an identical project', () => {
    const file = join(scratch(), 'demo.pinbench')
    const project = {
      ...DEFAULT_PROJECT,
      platformioDir: '/home/me/meshcore',
      env: 'env-a',
      partConfig: { 'u2.sf': '7', 'u3.backlight': false },
      selectedPartId: 'u3'
    }
    writeProjectFile(file, project)
    expect(readProjectFile(file)).toEqual(project)
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true)
  })

  it('coerces a hand-mangled file to defaults rather than throwing', () => {
    const file = join(scratch(), 'bad.pinbench')
    writeProjectFile(file, DEFAULT_PROJECT)
    // Overwrite with something structurally wrong.
    writeFileSync(file, '{"version": 99, "boardId": 7}')
    expect(readProjectFile(file)).toEqual(DEFAULT_PROJECT)
  })
})
