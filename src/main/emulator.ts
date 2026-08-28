import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { EventEmitter } from 'node:events'
import { canTransition, transition } from '../shared/emulator'
import type { EmulatorState, EmulatorStatus } from '../shared/emulator'
import type { SerialLine } from '../shared/serial'
import { stripAnsi } from '../shared/serial'

const BINARY_NAME = 'qemu-system-xtensa'

const REPO_QEMU = resolve(__dirname, '../../.qemu/build', BINARY_NAME)

const SEARCH_PATHS = [
  REPO_QEMU,
  join(homedir(), '.espressif', 'tools', 'qemu', BINARY_NAME),
  join(homedir(), '.espressif', 'tools', 'qemu-xtensa', BINARY_NAME),
  '/usr/local/bin',
  '/opt/homebrew/bin'
]

export class EmulatorSupervisor extends EventEmitter {
  private state: EmulatorState = 'idle'
  private child: ChildProcess | null = null
  private startTime = 0
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private pendingLines: SerialLine[] = []
  private partial = ''
  private qemuPath: string | null = null
  private lastFirmwarePath: string | null = null
  private pendingRestart: ((status: EmulatorStatus) => void) | null = null

  getStatus(): EmulatorStatus {
    return { state: this.state }
  }

  findQemu(): string {
    if (this.qemuPath) return this.qemuPath

    const envOverride = process.env['PINBENCH_QEMU']
    if (envOverride && existsSync(envOverride)) {
      this.qemuPath = envOverride
      return envOverride
    }

    for (const searchPath of SEARCH_PATHS) {
      const candidate = searchPath.endsWith(BINARY_NAME) ? searchPath : join(searchPath, BINARY_NAME)
      if (existsSync(candidate)) {
        this.qemuPath = candidate
        return candidate
      }
    }

    return BINARY_NAME
  }

  start(firmwarePath: string): void {
    if (!canTransition(this.state, 'starting')) return
    this.setState('starting')
    this.lastFirmwarePath = firmwarePath

    const qemu = this.findQemu()
    this.startTime = Date.now()
    this.partial = ''
    this.pendingLines = []

    const args = [
      '-nographic',
      '-machine', 'esp32s3',
      '-m', '8M',
      '-global', 'ssi_psram.is_octal=true',
      '-drive', `file=${firmwarePath},if=mtd,format=raw`,
      '-monitor', 'none',
      '-serial', 'stdio',
      '-no-reboot'
    ]

    let child: ChildProcess
    try {
      child = spawn(qemu, args, { stdio: ['pipe', 'pipe', 'pipe'] })
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
    this.child.stdin.write(text + '\n')
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
