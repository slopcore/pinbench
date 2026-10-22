import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const MARK = '__PINBENCH_PATH__'

/** Where PlatformIO and Homebrew usually live, for when the shell probe fails. */
export function fallbackPathEntries(home = homedir()): string[] {
  return [join(home, '.platformio', 'penv', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
}

/** `PATH` from the user's login shell, or null if it could not be read. */
function loginShellPath(): string | null {
  const shell = process.env['SHELL'] || '/bin/zsh'
  try {
    const out = execFileSync(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    // Interactive rc files may print banners; take only what sits between the marks.
    const match = new RegExp(`${MARK}(.*)${MARK}`).exec(out)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

/** `current` with `extra` entries appended, de-duplicated, order kept. */
export function mergePath(current: string, extra: readonly string[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of [...current.split(delimiter), ...extra]) {
    if (entry && !seen.has(entry)) {
      seen.add(entry)
      out.push(entry)
    }
  }
  return out.join(delimiter)
}

/**
 * A macOS app launched from Finder or the Dock inherits launchd's minimal
 * `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), so `pio`, `python3` and the
 * toolchains PlatformIO spawns are not found. Adopt the login shell's `PATH`,
 * plus the usual install locations as a fallback. Packaged builds only — `npm
 * run dev` already runs inside a shell.
 */
export function adoptLoginShellPath(): void {
  if (process.platform !== 'darwin') return
  const shellPath = loginShellPath()
  process.env['PATH'] = mergePath(process.env['PATH'] ?? '', [
    ...(shellPath ? shellPath.split(delimiter) : []),
    ...fallbackPathEntries()
  ])
}
