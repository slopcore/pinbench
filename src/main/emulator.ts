import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { EventEmitter } from 'node:events'
import {
  canTransition,
  DEFAULT_LAUNCH_OPTIONS,
  networkArgs,
  uart1Args,
  qemuBinaryFor,
  transition
} from '../shared/emulator'
import type { EmulatorLaunchOptions, EmulatorState, EmulatorStatus } from '../shared/emulator'
import type { SerialLine } from '../shared/serial'
import { stripAnsi } from '../shared/serial'

/**
 * The QEMU a packaged build ships (`scripts/bundle-qemu.mjs` → `Resources/qemu`):
 * `bin/` binaries, `lib/` their dylibs, `share/` the ESP ROMs. Null in dev and
 * under Node (tests), where `process.resourcesPath` is Electron's own or unset.
 */
function bundledQemuDir(): string | null {
  const resources = (process as { resourcesPath?: string }).resourcesPath
  if (!resources) return null
  const dir = join(resources, 'qemu')
  return existsSync(join(dir, 'bin')) ? dir : null
}

/** Where to look for `binary` (`qemu-system-xtensa` / `qemu-system-riscv32`), in order. */
function searchPaths(binary: string): string[] {
  const espArch = binary === 'qemu-system-riscv32' ? 'qemu-riscv32' : 'qemu-xtensa'
  const bundled = bundledQemuDir()
  return [
    ...(bundled ? [join(bundled, 'bin', binary)] : []),
    resolve(__dirname, '../../.qemu/build', binary),
    join(homedir(), '.espressif', 'tools', 'qemu', binary),
    join(homedir(), '.espressif', 'tools', espArch, binary),
    join('/usr/local/bin', binary),
    join('/opt/homebrew/bin', binary)
  ]
}

/**
 * Env overrides per binary: `PINBENCH_QEMU` (Xtensa, as before) and
 * `PINBENCH_QEMU_RISCV32` (the C6).
 */
function envOverride(binary: string): string | undefined {
  return process.env[binary === 'qemu-system-riscv32' ? 'PINBENCH_QEMU_RISCV32' : 'PINBENCH_QEMU']
}

export class EmulatorSupervisor extends EventEmitter {
  private state: EmulatorState = 'idle'
  private child: ChildProcess | null = null
  private startTime = 0
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private pendingLines: SerialLine[] = []
  private partial = ''
  private qemuPaths = new Map<string, string>()
  private deviceSocket: string | null = null
  private uart1Socket: string | null = null
  private lastFirmwarePath: string | null = null
  private lastLaunchOptions: EmulatorLaunchOptions = DEFAULT_LAUNCH_OPTIONS
  private pendingRestart: ((status: EmulatorStatus) => void) | null = null

  getStatus(): EmulatorStatus {
    return { state: this.state }
  }

  /**
   * Path of the PinBench device-host Unix socket. Passed to QEMU in the child
   * environment as `PINBENCH_DEVICE_SOCKET`; the fork's SPI2/SPI3 controllers
   * connect to it and round-trip transactions to the TypeScript device models
   * (M6). Unset means the guest talks to nothing — the pre-M6 behaviour.
   */
  setDeviceSocket(path: string | null): void {
    this.deviceSocket = path
  }

  /**
   * Unix socket the device host serves SoC UART1 on (a TWN4 reader, a GPS…).
   * QEMU connects to it as a chardev client and refuses to start if nothing
   * listens, so the args are only added when the socket file exists at spawn.
   */
  setUart1Socket(path: string | null): void {
    this.uart1Socket = path
  }

  /** The QEMU binary for `machine` (default `esp32s3`); falls back to a bare `PATH` lookup. */
  findQemu(machine?: string): string {
    const binary = qemuBinaryFor(machine)
    const cached = this.qemuPaths.get(binary)
    if (cached) return cached

    const override = envOverride(binary)
    const found = [...(override ? [override] : []), ...searchPaths(binary)].find((p) =>
      existsSync(p)
    )
    if (found) this.qemuPaths.set(binary, found)
    return found ?? binary
  }

  start(firmwarePath: string, options?: EmulatorLaunchOptions): void {
    if (!canTransition(this.state, 'starting')) return
    this.setState('starting')
    this.lastFirmwarePath = firmwarePath
    if (options) this.lastLaunchOptions = options
    const launch = this.lastLaunchOptions

    const qemu = this.findQemu(launch.machine)
    this.startTime = Date.now()
    this.partial = ''
    this.pendingLines = []

    const isEsp32S3 = (launch.machine ?? 'esp32s3') === 'esp32s3'
    // The bundled binary is relocated, so point it at its ROMs explicitly.
    const bundled = bundledQemuDir()
    const romArgs = bundled && qemu.startsWith(bundled) ? ['-L', join(bundled, 'share')] : []
    const args = [
      ...romArgs,
      '-nographic',
      '-machine',
      launch.machine ?? 'esp32s3',
      ...(launch.psramSize && !isEsp32S3 ? ['-m', launch.psramSize] : []),
      ...(launch.psramOctal && !isEsp32S3 ? ['-global', 'ssi_psram.is_octal=true'] : []),
      '-drive',
      `file=${firmwarePath},if=mtd,format=raw`,
      '-serial',
      'mon:stdio',
      '-no-reboot',
      ...networkArgs(launch.network),
      ...uart1Args(this.uart1Socket && existsSync(this.uart1Socket) ? this.uart1Socket : null)
    ]

    const env = this.deviceSocket
      ? { ...process.env, PINBENCH_DEVICE_SOCKET: this.deviceSocket }
      : process.env

    let child: ChildProcess
    try {
      child = spawn(qemu, args, { stdio: ['pipe', 'pipe', 'pipe'], env })
    } catch (error) {
      this.setState('crashed', `Failed to spawn QEMU: ${String(error)}`)
      return
    }
    this.child = child

    child.on('error', (error) => {
      this.child = null
      this.flushSerial()
      this.stopFlushTimer()
      this.setState('crashed', `QEMU error: ${error.message}`)
    })

    child.on('exit', (code, signal) => {
      this.child = null
      this.flushSerial()
      this.stopFlushTimer()
      if (this.state === 'stopping') {
        this.setState('idle')
      } else {
        const reason = signal ? `killed by ${signal}` : `exit code ${code}`
        this.setState('crashed', `QEMU exited: ${reason}`)
      }
    })

    if (child.stdout) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => this.onData(chunk))
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => this.onData(chunk))
    }

    this.startFlushTimer()
    this.setState('running')
  }

  stop(): void {
    if (!canTransition(this.state, 'stopping')) return
    this.setState('stopping')
    this.killChild()
  }

  reset(): void {
    const path = this.lastFirmwarePath
    if (!path) return
    if (this.state === 'idle' || this.state === 'crashed') {
      this.start(path)
      return
    }
    if (!canTransition(this.state, 'stopping')) return
    const onIdle = (status: EmulatorStatus): void => {
      if (status.state === 'idle') {
        this.removeListener('status', onIdle)
        this.pendingRestart = null
        this.start(path)
      }
    }
    this.pendingRestart = onIdle
    this.on('status', onIdle)
    this.setState('stopping')
    this.killChild()
  }

  writeSerial(text: string): void {
    if (this.state !== 'running' || !this.child?.stdin?.writable) return
    this.child.stdin.write(text.endsWith('\n') ? text : text + '\n')
  }

  /**
   * Write raw bytes to UART0 (no trailing newline). Used for binary on-wire
   * protocols the guest speaks over the console — e.g. the MeshCore companion
   * app protocol. Note UART0 is muxed with the QEMU monitor (`mon:stdio`), so a
   * `0x01` byte is swallowed as the monitor escape; keep such frames 0x01-free.
   */
  writeSerialBytes(bytes: Uint8Array): void {
    if (this.state !== 'running' || !this.child?.stdin?.writable) return
    this.child.stdin.write(Buffer.from(bytes))
  }

  /** The image most recently started, or null if the emulator has never run. */
  lastFirmware(): string | null {
    return this.lastFirmwarePath
  }

  dispose(): void {
    if (this.pendingRestart) {
      this.removeListener('status', this.pendingRestart)
      this.pendingRestart = null
    }
    this.stopFlushTimer()
    if (this.child) {
      this.child.kill('SIGKILL')
      this.child = null
    }
  }

  private setState(to: EmulatorState, error?: string): void {
    this.state = transition(this.state, to)
    const status: EmulatorStatus = { state: this.state, ...(error !== undefined ? { error } : {}) }
    this.emit('status', status)
  }

  private onData(chunk: string): void {
    const t = Date.now() - this.startTime
    const raw = this.partial + chunk
    const parts = raw.split(/\r?\n/)
    this.partial = parts.pop()!

    for (const text of parts) {
      this.pendingLines.push({ t, text: stripAnsi(text) })
    }
  }

  private flushSerial(): void {
    if (this.pendingLines.length === 0) return
    const batch = this.pendingLines
    this.pendingLines = []
    this.emit('serial', batch)
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => this.flushSerial(), 25)
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
  }

  private killChild(): void {
    if (!this.child) return
    this.child.kill('SIGTERM')
    const child = this.child
    setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL')
    }, 2000)
  }
}
