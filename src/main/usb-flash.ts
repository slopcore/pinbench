import { execFile, spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir as fsMkdir, writeFile as fsWriteFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { BuildOutputLine } from '../shared/build'
import type { ProjectConfig } from '../shared/pio'
import { coreDirForPlatform, usbBuildOverrideIni } from '../shared/pio'
import { stripAnsi } from '../shared/serial'
import { LineStreamer } from '../shared/stream'
import {
  canTransition,
  eraseFlashArgs,
  flashPercentFromLine,
  parsePortList,
  transition,
  writeFlashArgs
} from '../shared/usb-flash'
import type { SerialPortInfo, UsbFlashState, UsbFlashStatus } from '../shared/usb-flash'
import type { UsbFlashRequest } from '../shared/ipc'
import {
  findPio,
  locateFlashTools,
  pythonForPio,
  readProjectConfig,
  resolvePioEnvironment
} from './pio'

const runFile = promisify(execFile)

export interface UsbFlashRunnerDeps {
  spawn: typeof nodeSpawn
  fileExists: (path: string) => boolean
  writeFile: (path: string, data: string) => Promise<void>
  mkdir: (path: string) => Promise<void>
  resolvePio: () => Promise<{ pio: string; coreDir: string }>
  readProjectConfig: (projectDir: string) => Promise<ProjectConfig>
  /** `pio device list --json-output`, already parsed. */
  listPorts: () => Promise<SerialPortInfo[]>
  /** PinBench-owned scratch dir — holds the `-c` override and the build tree. */
  cacheDir: string
}

function defaultDeps(userDataDir: string, cacheDir: string): UsbFlashRunnerDeps {
  return {
    spawn: nodeSpawn,
    fileExists: existsSync,
    writeFile: (path, data) => fsWriteFile(path, data, 'utf8'),
    mkdir: async (path) => {
      await fsMkdir(path, { recursive: true })
    },
    resolvePio: () => resolvePioEnvironment(userDataDir),
    readProjectConfig: (projectDir) => readProjectConfig(userDataDir, projectDir),
    listPorts: async () => {
      const pio = findPio(userDataDir)
      const { stdout } = await runFile(pio, ['device', 'list', '--json-output'], {
        timeout: 20_000,
        maxBuffer: 8 * 1024 * 1024
      })
      return parsePortList(JSON.parse(stdout))
    },
    cacheDir
  }
}

/**
 * Drives one USB flash: a board-native `pio run` (no flash-mode override, just a
 * redirected `build_dir`), then esptool `erase_flash` (optional) and
 * `write_flash` against the chosen port. One runner, one flash at a time.
 * Mirrors `BuildRunner`'s shape — EventEmitter, injected deps, a `running`
 * guard, `\r`-aware streaming.
 */
export class UsbFlashRunner extends EventEmitter {
  private state: UsbFlashState = 'idle'
  private child: ChildProcess | null = null
  private cancelled = false
  private running = false
  private mode: UsbFlashRequest['mode'] = 'flash'
  private port = ''
  private exitCode = 0
  private readonly deps: UsbFlashRunnerDeps

  constructor(deps: Partial<UsbFlashRunnerDeps> & { userDataDir: string; cacheDir: string }) {
    super()
    this.deps = { ...defaultDeps(deps.userDataDir, deps.cacheDir), ...deps }
  }

  getStatus(): UsbFlashStatus {
    return { state: this.state, mode: this.mode, ...(this.port ? { port: this.port } : {}) }
  }

  listPorts(): Promise<SerialPortInfo[]> {
    return this.deps.listPorts()
  }

  async run(request: UsbFlashRequest): Promise<void> {
    if (this.running) throw new Error('A USB flash is already running')
    this.running = true
    this.cancelled = false
    this.mode = request.mode
    this.port = request.port
    const chip = request.chip ?? 'esp32s3'

    this.setState('building')

    let pio: string
    let coreDir: string
    let config: ProjectConfig
    try {
      ;({ pio, coreDir } = await this.deps.resolvePio())
      config = await this.deps.readProjectConfig(request.projectDir)
    } catch (error) {
      return this.fail(`Could not read the PlatformIO project: ${String(error)}`)
    }
    if (!config.envs.includes(request.env)) {
      return this.fail(
        `Environment "${request.env}" is not in platformio.ini (have: ${config.envs.join(', ') || 'none'})`
      )
    }
    if (this.cancelled) return this.setState('cancelled')

    // Board-native build (no flash-mode override), into a PinBench-owned tree so
    // it never clobbers `.pio/build/<env>` where the DIO emulator build lives.
    const buildRoot = join(this.deps.cacheDir, 'usb-build', sanitise(basename(request.projectDir)))
    const overridePath = join(
      this.deps.cacheDir,
      `usb-override-${sanitise(basename(request.projectDir))}.ini`
    )
    try {
      await this.deps.mkdir(this.deps.cacheDir)
      await this.deps.writeFile(
        overridePath,
        usbBuildOverrideIni({
          userConfigPath: join(request.projectDir, 'platformio.ini'),
          buildDir: buildRoot
        })
      )
    } catch (error) {
      return this.fail(`Could not write the USB-flash build config: ${String(error)}`)
    }

    // A pioarduino env (the ESP32-C6) builds in its own core dir — see coreDirForPlatform.
    const buildCoreDir = coreDirForPlatform(config.options[request.env]?.['platform'], coreDir)
    this.emitLine('stdout', `$ pio run -e ${request.env} (board-native, for USB flash)`)
    const buildOk = await this.spawnStreamed(
      pio,
      ['run', '-d', request.projectDir, '-e', request.env, '-c', overridePath],
      request.projectDir,
      buildCoreDir === coreDir ? undefined : { ...process.env, PLATFORMIO_CORE_DIR: buildCoreDir }
    )
    if (buildOk === null) return
    if (this.exitCode !== 0) return this.fail(`pio run exited with code ${this.exitCode}`)

    const buildDir = join(buildRoot, request.env)
    for (const artifact of ['bootloader.bin', 'partitions.bin', 'firmware.bin']) {
      if (!this.deps.fileExists(join(buildDir, artifact))) {
        return this.fail(`Build produced no ${artifact} in ${buildDir}`)
      }
    }
    const { esptool, bootApp0 } = locateFlashTools(buildCoreDir, [coreDir, buildCoreDir])
    if (!this.deps.fileExists(bootApp0)) {
      return this.fail(`Missing boot_app0.bin under the PlatformIO core dir (${buildCoreDir})`)
    }
    if (this.cancelled) return this.setState('cancelled')

    const python = pythonForPio(pio)

    if (request.mode === 'erase-flash') {
      this.setState('erasing')
      this.emitLine('stdout', `$ esptool erase_flash --port ${request.port}`)
      const eraseOk = await this.spawnStreamed(
        python,
        [esptool, ...eraseFlashArgs(chip, request.port)],
        request.projectDir
      )
      if (eraseOk === null) return
      if (this.exitCode !== 0)
        return this.fail(`esptool erase_flash exited with code ${this.exitCode}`)
      if (this.cancelled) return this.setState('cancelled')
    }

    this.setState('flashing')
    this.emitLine('stdout', `$ esptool write_flash --port ${request.port}`)
    const writeOk = await this.spawnStreamed(
      python,
      [esptool, ...writeFlashArgs({ chip, port: request.port, buildDir, bootApp0, join })],
      request.projectDir
    )
    if (writeOk === null) return
    if (this.exitCode !== 0)
      return this.fail(`esptool write_flash exited with code ${this.exitCode}`)

    this.finish()
  }

  cancel(): void {
    this.cancelled = true
    this.killGroup()
  }

  dispose(): void {
    this.cancelled = true
    this.killGroup()
  }

  private spawnStreamed(
    command: string,
    args: string[],
    cwd: string,
    env?: NodeJS.ProcessEnv
  ): Promise<'ok' | null> {
    return new Promise((resolvePromise) => {
      let child: ChildProcess
      try {
        child = this.deps.spawn(command, args, {
          cwd,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          ...(env ? { env } : {})
        })
      } catch (error) {
        this.fail(`Could not start ${basename(command)}: ${String(error)}`)
        resolvePromise(null)
        return
      }
      this.child = child

      const wire = (stream: 'stdout' | 'stderr'): void => {
        const source = stream === 'stdout' ? child.stdout : child.stderr
        if (!source) return
        source.setEncoding('utf8')
        const streamer = new LineStreamer()
        source.on('data', (chunk: string) => {
          for (const segment of streamer.push(chunk)) {
            this.emitLine(stream, stripAnsi(segment.text), segment.replace)
          }
        })
        source.on('end', () => {
          const tail = streamer.flush()
          if (tail) this.emitLine(stream, stripAnsi(tail.text))
        })
      }
      wire('stdout')
      wire('stderr')

      let settled = false
      const settle = (value: 'ok' | null): void => {
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
        if (code !== null && code !== undefined) this.exitCode = code ?? (signal ? 1 : 0)
        if (this.cancelled) {
          this.setState('cancelled')
          settle(null)
          return
        }
        settle('ok')
      })
    })
  }

  private emitLine(stream: 'stdout' | 'stderr', text: string, replace = false): void {
    this.emit('output', { stream, text, replace } satisfies BuildOutputLine)
    if (this.state === 'flashing') {
      const percent = flashPercentFromLine(text)
      if (percent !== null) this.emitState({ percent })
    }
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

  private finish(): void {
    this.running = false
    this.state = transition(this.state, 'done')
    this.emitState({})
  }

  private fail(error: string): void {
    if (this.state === 'failed') return
    this.running = false
    this.state = transition(this.state, 'failed')
    this.emitState({ error })
  }

  private setState(to: UsbFlashState): void {
    if (to === this.state) return
    // A cancel racing a spawn error can ask for failed→cancelled; ignore it
    // rather than throw — whichever terminal state landed first wins.
    if (!canTransition(this.state, to)) return
    if (to === 'cancelled') this.running = false
    this.state = transition(this.state, to)
    this.emitState({})
  }

  private emitState(extra: Partial<UsbFlashStatus>): void {
    this.emit('state', {
      state: this.state,
      mode: this.mode,
      ...(this.port ? { port: this.port } : {}),
      ...extra
    } satisfies UsbFlashStatus)
  }
}

function sanitise(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, '_')
}
