import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdir as fsMkdir, writeFile as fsWriteFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { canTransition, phaseFromLine, transition } from '../shared/build'
import type { BuildOutputLine, BuildState, BuildStatus } from '../shared/build'
import { bySeverity, parseDiagnostics } from '../shared/diagnostics'
import type { Diagnostic } from '../shared/diagnostics'
import { BUILD_ARTIFACTS, mergeBinArgs, parseSize } from '../shared/flash'
import { overrideConfigIni } from '../shared/pio'
import type { ProjectConfig } from '../shared/pio'
import { locateFlashTools, pythonForPio, readProjectConfig, resolvePioEnvironment } from './pio'
import { stripAnsi } from '../shared/serial'
import { LineStreamer } from '../shared/stream'

export interface BuildRunOptions {
  projectDir: string
  env: string
  /** Emulator target; only the flash-image size is used here. */
  emulator: { psramSize?: string }
}

export interface BuildRunnerDeps {
  spawn: typeof nodeSpawn
  writeFile: (path: string, data: string) => Promise<void>
  mkdir: (path: string) => Promise<void>
  fileExists: (path: string) => boolean
  mtime: (path: string) => number
  resolvePio: () => Promise<{ pio: string; coreDir: string }>
  readProjectConfig: (projectDir: string) => Promise<ProjectConfig>
  /** PinBench-owned scratch dir for the override config and merged images. */
  cacheDir: string
}

/** Flash image size when the board does not pin one — the spike's proven value. */
const DEFAULT_FLASH_BYTES = 8 * 1024 * 1024

function defaultDeps(cacheDir: string, userDataDir: string): BuildRunnerDeps {
  return {
    spawn: nodeSpawn,
    writeFile: (path, data) => fsWriteFile(path, data, 'utf8'),
    mkdir: async (path) => {
      await fsMkdir(path, { recursive: true })
    },
    fileExists: existsSync,
    mtime: (path) => statSync(path).mtimeMs,
    resolvePio: () => resolvePioEnvironment(userDataDir),
    readProjectConfig: (projectDir) => readProjectConfig(userDataDir, projectDir),
    cacheDir
  }
}

/**
 * Drives `pio run` and the flash-image merge for one build, streaming output
 * and phase transitions. One runner, one build at a time; `run` rejects if a
 * build is already in flight.
 */
export class BuildRunner extends EventEmitter {
  private state: BuildState = 'idle'
  private env: string | undefined
  private child: ChildProcess | null = null
  private cancelled = false
  /** Set for the whole of `run()`, including the async `preparing` window. */
  private running = false
  private readonly deps: BuildRunnerDeps

  constructor(deps: Partial<BuildRunnerDeps> & { cacheDir: string; userDataDir?: string }) {
    super()
    this.deps = { ...defaultDeps(deps.cacheDir, deps.userDataDir ?? deps.cacheDir), ...deps }
  }

  getStatus(): BuildStatus {
    return { state: this.state, ...(this.env === undefined ? {} : { env: this.env }) }
  }

  async run(options: BuildRunOptions): Promise<void> {
    if (this.running) throw new Error('A build is already running')
    this.running = true
    this.cancelled = false
    this.env = options.env
    this.setState('preparing')

    let pio: string
    let coreDir: string
    let projectConfig: ProjectConfig
    try {
      ;({ pio, coreDir } = await this.deps.resolvePio())
      projectConfig = await this.deps.readProjectConfig(options.projectDir)
    } catch (error) {
      return this.fail(`Could not read the PlatformIO project: ${String(error)}`)
    }

    if (!projectConfig.envs.includes(options.env)) {
      return this.fail(
        `Environment "${options.env}" is not in platformio.ini (have: ${projectConfig.envs.join(', ') || 'none'})`
      )
    }
    if (this.cancelled) return this.setState('cancelled')

    const userConfigPath = join(options.projectDir, 'platformio.ini')
    const overridePath = join(
      this.deps.cacheDir,
      `override-${sanitise(basename(options.projectDir))}.ini`
    )
    try {
      await this.deps.mkdir(this.deps.cacheDir)
      await this.deps.writeFile(
        overridePath,
        overrideConfigIni({ userConfigPath, envs: projectConfig.envs })
      )
    } catch (error) {
      return this.fail(`Could not write the emulator build config: ${String(error)}`)
    }

    const buildDir = join(options.projectDir, '.pio', 'build', options.env)
    const firmwareBin = join(buildDir, 'firmware.bin')
    let compiled = false

    const args = ['run', '-d', options.projectDir, '-e', options.env, '-c', overridePath]
    const transcript = await this.spawnStreamed(pio, args, options.projectDir, (line) => {
      const phase = phaseFromLine(line)
      if (phase === 'compiling') compiled = true
      if (phase && canTransition(this.state, phase)) this.setState(phase)
    })

    if (transcript === null) return // cancelled or spawn error, already handled
    if (this.exitCode !== 0) {
      const rows = this.diagnose(transcript, options.projectDir)
      if (rows.length > 0) this.emit('diagnostics', rows)
      return this.fail(
        rows.some((r) => r.severity === 'error')
          ? `Build failed — ${rows.filter((r) => r.severity === 'error').length} error(s)`
          : `pio run exited with code ${this.exitCode}`
      )
    }

    // The build succeeded; surface any warnings it emitted.
    const warnings = this.diagnose(transcript, options.projectDir)
    if (warnings.length > 0) this.emit('diagnostics', warnings)

    for (const artifact of BUILD_ARTIFACTS) {
      if (!this.deps.fileExists(join(buildDir, artifact))) {
        return this.fail(`Build produced no ${artifact} in ${buildDir}`)
      }
    }

    const { esptool, bootApp0 } = locateFlashTools(coreDir)
    if (!this.deps.fileExists(bootApp0)) {
      return this.fail(`Missing boot_app0.bin under the PlatformIO core dir (${coreDir})`)
    }

    const imagePath = join(
      this.deps.cacheDir,
      `${sanitise(basename(options.projectDir))}-${sanitise(options.env)}.bin`
    )
    const sizeBytes = options.emulator.psramSize
      ? Math.max(DEFAULT_FLASH_BYTES, parseSize(options.emulator.psramSize))
      : DEFAULT_FLASH_BYTES

    // Skip the merge when the image is already current and nothing recompiled.
    if (
      !compiled &&
      this.deps.fileExists(imagePath) &&
      this.deps.mtime(imagePath) >= this.deps.mtime(firmwareBin)
    ) {
      return this.finish(imagePath, true)
    }
    if (this.cancelled) return this.setState('cancelled')

    this.setState('merging')
    const mergeArgs = [
      esptool,
      ...mergeBinArgs({ buildDir, bootApp0, out: imagePath, sizeBytes, join })
    ]
    const mergeTranscript = await this.spawnStreamed(
      pythonForPio(pio),
      mergeArgs,
      options.projectDir,
      () => undefined
    )
    if (mergeTranscript === null) return
    if (this.exitCode !== 0) {
      return this.fail(`Flash image merge failed (esptool exit ${this.exitCode})`)
    }

    this.finish(imagePath, false)
  }

  cancel(): void {
    // Set before the child check: a cancel during the async `preparing` window
    // has no process to kill yet, but `run()`'s checkpoints must still see it.
    this.cancelled = true
    this.killGroup()
  }

  dispose(): void {
    this.cancelled = true
    this.killGroup()
  }

  private exitCode = 0

  /**
   * Spawn a child, stream both pipes through a CR-aware splitter, and resolve
   * with the full plain-text transcript once it *closes* — `'close'` fires
   * after both stdio streams have flushed, so the tail of the transcript (where
   * the final compiler error sits) is never lost to an early `'exit'`. Resolves
   * `null` if the spawn errors or the build was cancelled.
   */
  private spawnStreamed(
    command: string,
    args: string[],
    cwd: string,
    onLine: (line: string) => void
  ): Promise<string | null> {
    return new Promise((resolvePromise) => {
      let child: ChildProcess
      try {
        child = this.deps.spawn(command, args, {
          cwd,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (error) {
        this.fail(`Could not start ${basename(command)}: ${String(error)}`)
        resolvePromise(null)
        return
      }
      this.child = child

      const parts: string[] = []
      const wire = (stream: 'stdout' | 'stderr'): void => {
        const source = stream === 'stdout' ? child.stdout : child.stderr
        if (!source) return
        source.setEncoding('utf8')
        const streamer = new LineStreamer()
        source.on('data', (chunk: string) => {
          for (const segment of streamer.push(chunk)) {
            const text = stripAnsi(segment.text)
            const line: BuildOutputLine = { stream, text, replace: segment.replace }
            this.emit('output', line)
            if (!segment.replace) {
              parts.push(text)
              onLine(text)
            }
          }
        })
        source.on('end', () => {
          const tail = streamer.flush()
          if (tail) {
            const text = stripAnsi(tail.text)
            this.emit('output', { stream, text, replace: false } satisfies BuildOutputLine)
            parts.push(text)
            onLine(text)
          }
        })
      }
      wire('stdout')
      wire('stderr')

      let settled = false
      const settle = (value: string | null): void => {
        if (settled) return
        settled = true
        this.child = null
        resolvePromise(value)
      }

      child.on('error', (error) => {
        this.fail(`${basename(command)} error: ${error.message}`)
        settle(null)
      })
      child.on('exit', (code, signal) => {
        this.exitCode = code ?? (signal ? 1 : 0)
      })
      child.on('close', (code, signal) => {
        if (!settled && code !== null && code !== undefined) {
          this.exitCode = code ?? (signal ? 1 : 0)
        }
        if (this.cancelled) {
          this.setState('cancelled')
          settle(null)
          return
        }
        settle(parts.join('\n'))
      })
    })
  }

  private diagnose(transcript: string, projectDir: string): Diagnostic[] {
    return parseDiagnostics(transcript, {
      projectRoot: projectDir,
      resolve: (root, file) => resolve(root, file),
      isAbsolute
    }).sort(bySeverity)
  }

  private killGroup(): void {
    const child = this.child
    if (!child?.pid) return
    try {
      if (process.platform === 'win32') {
        this.deps.spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'])
      } else {
        process.kill(-child.pid, 'SIGTERM')
      }
    } catch {
      child.kill('SIGKILL')
    }
  }

  private finish(image: string, cached: boolean): void {
    this.running = false
    this.state = transition(this.state, 'done')
    this.emit('state', {
      state: this.state,
      image,
      cached,
      ...(this.env === undefined ? {} : { env: this.env })
    } satisfies BuildStatus)
  }

  private fail(error: string): void {
    if (this.state === 'failed') return
    this.running = false
    this.state = transition(this.state, 'failed')
    this.emit('state', {
      state: this.state,
      error,
      ...(this.env === undefined ? {} : { env: this.env })
    } satisfies BuildStatus)
  }

  private setState(to: BuildState): void {
    if (to === this.state) return
    if (to === 'cancelled') this.running = false
    this.state = transition(this.state, to)
    this.emit('state', {
      state: this.state,
      ...(this.env === undefined ? {} : { env: this.env })
    } satisfies BuildStatus)
  }
}

function sanitise(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, '_')
}
