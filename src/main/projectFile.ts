/**
 * Reading and writing `.pinbench` project files. Writes are atomic — a
 * half-written project file must never be what the app tries to reopen next
 * launch.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { normaliseProject, serialiseProject, type ProjectFile } from '../shared/project'

export function readProjectFile(path: string): ProjectFile {
  return normaliseProject(JSON.parse(readFileSync(path, 'utf8')))
}

export function writeProjectFile(path: string, project: ProjectFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, serialiseProject(project), 'utf8')
  renameSync(temporary, path)
}
