// @vitest-environment node
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fallbackPathEntries, mergePath } from './shellPath'

describe('mergePath', () => {
  it('appends new entries, keeps order and drops duplicates and blanks', () => {
    const p = (...entries: string[]): string => entries.join(delimiter)
    expect(
      mergePath(p('/usr/bin', '/bin'), ['/opt/homebrew/bin', '/bin', '', '/usr/local/bin'])
    ).toBe(p('/usr/bin', '/bin', '/opt/homebrew/bin', '/usr/local/bin'))
  })
})

describe('fallbackPathEntries', () => {
  it('includes the PlatformIO penv under the home directory', () => {
    expect(fallbackPathEntries('/Users/x')[0]).toBe(join('/Users/x', '.platformio', 'penv', 'bin'))
  })
})
