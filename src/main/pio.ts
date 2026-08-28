import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { parseProjectConfig } from '../shared/pio'
import type { ProjectConfig } from '../shared/pio'

const run = promisify(execFile)

const PIO_BIN = process.platform === 'win32' ? 'platformio.exe' : 'pio'

/**
 * Where the app keeps a virtualenv it bootstrapped itself, when the user has no
 * PlatformIO. Mirrors `EmulatorSupervisor.findQemu`'s search-list style.
 */
export function managedVenvPio(userDataDir: string): string {
  return process.platform === 'win32'
    ? join(userDataDir, 'pio-venv', 'Scripts', PIO_BIN)
    : join(userDataDir, 'pio-venv', 'bin', PIO_BIN)
}

/**
 * Resolve the `pio` executable: an explicit override, then the repo-local
 * developer venv, then an app-managed venv, then PATH. Returns the bare name as
 * a last resort so the caller's spawn error is the diagnostic.
 */
export function findPio(userDataDir: string): string {
  const override = process.env['PINBENCH_PIO']
  if (override && existsSync(override)) return override

  const repoVenv = resolve(__dirname, '../../.pio-venv/bin', PIO_BIN)
  if (existsSync(repoVenv)) return repoVenv

  const managed = managedVenvPio(userDataDir)
  if (existsSync(managed)) return managed

  return PIO_BIN
}

export interface PioEnvironment {
  pio: string
  /** PlatformIO core dir (`~/.platformio` by default) — holds the packages. */
  coreDir: string
}

export async function resolvePioEnvironment(userDataDir: string): Promise<PioEnvironment> {
  const pio = findPio(userDataDir)
  let coreDir = process.env['PLATFORMIO_CORE_DIR'] ?? join(homedir(), '.platformio')
  try {
    const { stdout } = await run(pio, ['system', 'info', '--json-output'], { timeout: 20_000 })
    const info = JSON.parse(stdout) as { core_dir?: { value?: string } }
    if (info.core_dir?.value) coreDir = info.core_dir.value
  } catch {
    // Fall back to the default; the merge step will report a missing package.
  }
  return { pio, coreDir }
}

export async function pioIsAvailable(userDataDir: string): Promise<boolean> {
  try {
    await run(findPio(userDataDir), ['--version'], { timeout: 20_000 })
    return true
  } catch {
    return false
  }
}

export async function readProjectConfig(
  userDataDir: string,
  projectDir: string
): Promise<ProjectConfig> {
  const pio = findPio(userDataDir)
  const { stdout } = await run(pio, ['project', 'config', '--json-output', '-d', projectDir], {
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024
  })
  return parseProjectConfig(JSON.parse(stdout))
}

/**
 * Locate esptool and the OTA-selector blob inside the PlatformIO core dir. The
 * esptool script name changed across `tool-esptoolpy` releases, so probe both.
 */
export function locateFlashTools(coreDir: string): { esptool: string; bootApp0: string } {
  const candidates = [
    join(coreDir, 'packages', 'tool-esptoolpy', 'esptool.py'),
    join(coreDir, 'packages', 'tool-esptoolpy', 'esptool', '__init__.py'),
    join(coreDir, 'packages', 'tool-esptoolpy', 'esptool')
  ]
  const esptool = candidates.find((path) => existsSync(path)) ?? candidates[0]!
  const bootApp0 = join(
    coreDir,
    'packages',
    'framework-arduinoespressif32',
    'tools',
    'partitions',
    'boot_app0.bin'
  )
  return { esptool, bootApp0 }
}

/** The interpreter that runs esptool — the one inside the resolved pio venv. */
export function pythonForPio(pio: string): string {
  // `<venv>/bin/pio` → `<venv>/bin/python3`; on a bare PATH pio, use `python3`.
  const binDir = pio.replace(/[/\\][^/\\]+$/, '')
  const candidate =
    process.platform === 'win32' ? join(binDir, 'python.exe') : join(binDir, 'python3')
  return existsSync(candidate) ? candidate : process.platform === 'win32' ? 'python' : 'python3'
}
