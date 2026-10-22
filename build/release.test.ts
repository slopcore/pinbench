// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { nextVersion, parseLog, renderNotes } from './release'

describe('nextVersion', () => {
  it('bumps patch, minor and major, accepting a v prefix', () => {
    expect(nextVersion('v1.4.2', 'patch')).toBe('1.4.3')
    expect(nextVersion('1.4.2', 'minor')).toBe('1.5.0')
    expect(nextVersion('v1.4.2', 'major')).toBe('2.0.0')
  })

  it('rejects a non-semver tag', () => {
    expect(() => nextVersion('nightly', 'patch')).toThrow(/not a semver/)
  })
})

describe('parseLog', () => {
  it('splits records and fields, ignoring blank trailing records', () => {
    const raw = 'aaa\x1ffeat: one\x1e\nbbb\x1ffix(ui): two\x1e\n'
    expect(parseLog(raw)).toEqual([
      { sha: 'aaa', subject: 'feat: one' },
      { sha: 'bbb', subject: 'fix(ui): two' }
    ])
  })
})

describe('renderNotes', () => {
  const repoUrl = 'https://github.com/slopcore/pinbench'
  const commits = [
    { sha: '1111111aaaa', subject: 'feat(radio): decode channel frames' },
    { sha: '2222222bbbb', subject: 'fix: dock tab badge' },
    { sha: '3333333cccc', subject: 'refactor!: drop the Source tab' },
    { sha: '4444444dddd', subject: 'Tidy the README' },
    { sha: '5555555eeee', subject: 'ci(mac): manual releases' }
  ]

  it('groups by type in a fixed order, with scope, breaking flag and linked SHA', () => {
    const notes = renderNotes(commits, { version: '0.2.0', previousTag: 'v0.1.0', repoUrl })
    const order = ['### Features', '### Fixes', '### Build & CI', '### Other'].map((h) =>
      notes.indexOf(h)
    )
    expect(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1]!))).toBe(true)
    expect(notes).toContain(
      `- **radio:** decode channel frames ([\`1111111\`](${repoUrl}/commit/1111111aaaa))`
    )
    expect(notes).toContain('- **BREAKING** drop the Source tab')
    expect(notes).toContain('- Tidy the README')
    expect(notes).toContain(`${repoUrl}/compare/v0.1.0...v0.2.0`)
  })

  it('says "first release" when there is no previous tag', () => {
    const notes = renderNotes(commits.slice(0, 1), { version: '0.1.0', previousTag: null, repoUrl })
    expect(notes).toContain('First release — 1 commit.')
  })
})
