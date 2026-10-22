import { describe, expect, it } from 'vitest'
import {
  OPERATIONS,
  classifyRisk,
  defaultPermissionPolicy,
  inputSchema,
  operation,
  parseParams
} from './operations'

describe('the operation catalogue', () => {
  it('has unique snake_case names', () => {
    const names = OPERATIONS.map((o) => o.name)
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]*$/)
  })

  it('covers the PinBenchApi surface and the board edits', () => {
    const names = new Set(OPERATIONS.map((o) => o.name))
    for (const expected of [
      'app_info',
      'board_get',
      'board_edit',
      'board_verify',
      'pinmap_preview',
      'project_open',
      'firmware_actions',
      'build_start',
      'emulator_start',
      'serial_write',
      'device_command',
      'menu_command'
    ]) {
      expect(names.has(expected)).toBe(true)
    }
  })

  it('classifies process- and hardware-touching ops as exec', () => {
    for (const n of [
      'build_start',
      'emulator_start',
      'emulator_reset',
      'serial_write',
      'project_open'
    ]) {
      expect(classifyRisk(n)).toBe('exec')
    }
    expect(classifyRisk('board_get')).toBe('read')
    expect(classifyRisk('board_edit')).toBe('write')
  })

  it('has no exec operation without a title for the prompt', () => {
    for (const op of OPERATIONS) expect(op.title.length).toBeGreaterThan(0)
  })
})

describe('defaultPermissionPolicy', () => {
  it('allows read and write, asks for exec', () => {
    expect(defaultPermissionPolicy(operation('board_get')!)).toBe('allow')
    expect(defaultPermissionPolicy(operation('board_edit')!)).toBe('allow')
    expect(defaultPermissionPolicy(operation('build_start')!)).toBe('ask')
  })
})

describe('inputSchema', () => {
  it('marks required fields and forbids extra keys', () => {
    const schema = inputSchema(operation('project_open')!)
    expect(schema).toEqual({
      type: 'object',
      properties: { dir: { type: 'string', description: expect.any(String) } },
      required: ['dir'],
      additionalProperties: false
    })
  })

  it('omits `required` entirely when nothing is mandatory', () => {
    const schema = inputSchema(operation('serial_read')!)
    expect('required' in schema).toBe(false)
  })
})

describe('parseParams', () => {
  it('accepts a valid payload and drops unknown keys', () => {
    const out = parseParams(operation('device_command')!, {
      partId: 'u2',
      command: 'inject',
      args: { rssi: -80 },
      bogus: 1
    })
    expect(out).toEqual({ partId: 'u2', command: 'inject', args: { rssi: -80 } })
  })

  it('treats missing/empty params as {} when nothing is required', () => {
    expect(parseParams(operation('app_info')!, undefined)).toEqual({})
  })

  it('throws on a missing required field', () => {
    expect(() => parseParams(operation('serial_write')!, {})).toThrow(/requires "text"/)
  })

  it('throws on a wrong type', () => {
    expect(() => parseParams(operation('serial_read')!, { limit: 'lots' })).toThrow(
      /must be a number/
    )
  })

  it('rejects a non-object payload', () => {
    expect(() => parseParams(operation('serial_write')!, 'hi')).toThrow(/expects an object/)
  })
})
