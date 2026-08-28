import { describe, expect, it } from 'vitest'
import { DEFAULT_PROJECT, normaliseProject, serialiseProject } from './project'

describe('normaliseProject', () => {
  it('round-trips a well-formed project', () => {
    const project = {
      version: 1 as const,
      boardId: 'demo-board',
      platformioDir: '/home/me/meshcore',
      env: 'env-a',
      partConfig: { 'u2.sf': '7', 'u3.backlight': true, 'u7.temperature': 21 },
      selectedPartId: 'u2'
    }
    expect(normaliseProject(project)).toEqual(project)
    expect(normaliseProject(JSON.parse(serialiseProject(project)))).toEqual(project)
  })

  it('falls back to defaults for a non-object or wrong version', () => {
    expect(normaliseProject(null)).toEqual(DEFAULT_PROJECT)
    expect(normaliseProject('nope')).toEqual(DEFAULT_PROJECT)
    expect(normaliseProject({ version: 2, boardId: 'x' })).toEqual(DEFAULT_PROJECT)
  })

  it('drops config values that are not string, number or boolean', () => {
    const result = normaliseProject({
      version: 1,
      partConfig: { good: 'a', alsoGood: 3, bad: { nested: true }, alsoBad: [1, 2] }
    })
    expect(result.partConfig).toEqual({ good: 'a', alsoGood: 3 })
  })

  it('coerces missing fields to a usable shape', () => {
    const result = normaliseProject({ version: 1 })
    expect(result.boardId).toBe(DEFAULT_PROJECT.boardId)
    expect(result.platformioDir).toBeNull()
    expect(result.env).toBeNull()
    expect(result.partConfig).toEqual({})
    expect(result.selectedPartId).toBeNull()
  })
})
