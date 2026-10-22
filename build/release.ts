/**
 * Release planning for `.github/workflows/release.yml`.
 *
 * A release covers every commit on main since the previous release tag
 * (`v<semver>`). This module picks the next version, collects those commits and
 * renders the GitHub Release notes, grouped by Conventional Commit type.
 *
 * The pure helpers are unit-tested (`release.test.ts`). The CLI at the bottom
 * runs in CI as `node --experimental-strip-types build/release.ts`, so this file
 * sticks to erasable TypeScript syntax and imports only Node built-ins.
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export type Bump = 'patch' | 'minor' | 'major'

export interface Commit {
  sha: string
  subject: string
}

/** `1.4.2` + `minor` → `1.5.0`. Accepts a leading `v`. */
export function nextVersion(current: string, bump: Bump): string {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(current.trim())
  if (!m) throw new Error(`not a semver version: ${current}`)
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (bump === 'major') return `${major + 1}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/** Field and record separators for `git log --format=%H%x1f%s%x1e`. */
export const LOG_FORMAT = '%H%x1f%s%x1e'

export function parseLog(raw: string): Commit[] {
  return raw
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = '', subject = ''] = record.split('\x1f')
      return { sha: sha.trim(), subject: subject.trim() }
    })
}

const SECTIONS: { title: string; types: string[] }[] = [
  { title: 'Features', types: ['feat'] },
  { title: 'Fixes', types: ['fix'] },
  { title: 'Performance', types: ['perf'] },
  { title: 'Docs', types: ['docs'] },
  { title: 'Build & CI', types: ['build', 'ci'] }
]

const CONVENTIONAL = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/

/** One bullet: scope in bold, the type prefix dropped, short SHA linked. */
function bullet(commit: Commit, repoUrl: string): string {
  const m = CONVENTIONAL.exec(commit.subject)
  const scope = m?.[2]
  const text = m ? m[4]! : commit.subject
  const breaking = m?.[3] ? '**BREAKING** ' : ''
  const short = commit.sha.slice(0, 7)
  return `- ${breaking}${scope ? `**${scope}:** ` : ''}${text} ([\`${short}\`](${repoUrl}/commit/${commit.sha}))`
}

/** The GitHub Release body. Commits are newest first, as `git log` gives them. */
export function renderNotes(
  commits: Commit[],
  context: { version: string; previousTag: string | null; repoUrl: string }
): string {
  const buckets = new Map<string, string[]>()
  for (const commit of commits) {
    const type = CONVENTIONAL.exec(commit.subject)?.[1]?.toLowerCase()
    const title =
      SECTIONS.find((s) => type !== undefined && s.types.includes(type))?.title ?? 'Other'
    buckets.set(title, [...(buckets.get(title) ?? []), bullet(commit, context.repoUrl)])
  }

  const lines: string[] = []
  for (const title of [...SECTIONS.map((s) => s.title), 'Other']) {
    const items = buckets.get(title)
    if (!items) continue
    lines.push(`### ${title}`, '', ...items, '')
  }
  const range = context.previousTag
    ? `**Full changelog:** ${context.repoUrl}/compare/${context.previousTag}...v${context.version}`
    : `First release — ${commits.length} commit${commits.length === 1 ? '' : 's'}.`
  lines.push(range, '')
  return lines.join('\n')
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const git = (...args: string[]): string =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

/** The newest `v<semver>` tag reachable from HEAD, or null before the first release. */
function previousReleaseTag(): string | null {
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD')
  } catch {
    return null
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

function main(): void {
  const bump = (arg('bump') ?? 'patch') as Bump
  const notesPath = arg('notes') ?? 'release-notes.md'
  const repoUrl = `${process.env['GITHUB_SERVER_URL'] ?? 'https://github.com'}/${process.env['GITHUB_REPOSITORY'] ?? 'slopcore/pinbench'}`

  const previousTag = previousReleaseTag()
  const range = previousTag ? `${previousTag}..HEAD` : 'HEAD'
  const commits = parseLog(git('log', '--no-merges', `--format=${LOG_FORMAT}`, range))
  if (commits.length === 0) {
    console.error(`Nothing to release: no commits on main since ${previousTag}.`)
    process.exit(1)
  }

  // The first release ships package.json's version as-is; later ones bump the last tag.
  const packageVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string })
    .version
  const version = previousTag ? nextVersion(previousTag, bump) : packageVersion
  const tag = `v${version}`
  if (git('tag', '--list', tag)) {
    console.error(`Tag ${tag} already exists.`)
    process.exit(1)
  }

  writeFileSync(notesPath, renderNotes(commits, { version, previousTag, repoUrl }))
  const outputs = { version, tag, previous: previousTag ?? '', count: String(commits.length) }
  const githubOutput = process.env['GITHUB_OUTPUT']
  if (githubOutput) {
    appendFileSync(
      githubOutput,
      Object.entries(outputs)
        .map(([k, v]) => `${k}=${v}\n`)
        .join('')
    )
  }
  console.log(
    `${tag}: ${commits.length} commit(s) since ${previousTag ?? 'the beginning'} → ${notesPath}`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
