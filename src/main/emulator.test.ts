// @vitest-environment node
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { spawn } from 'node:child_process'
import { EmulatorSupervisor } from './emulator'
import type { EmulatorStatus } from '../shared/emulator'
import type { SerialLine } from '../shared/serial'

interface FakeChild extends EventEmitter {
  stdin: PassThrough
  stdout: PassThrough & { setEncoding: ReturnType<typeof vi.fn> }
  stderr: PassThrough & { setEncoding: ReturnType<typeof vi.fn> }
  killed: boolean
  pid: number
  kill: ReturnType<typeof vi.fn>
}

let lastSpawned: FakeChild | null = null

vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>

  function makeFakeChild(): FakeChild {
    const emitter = new EventEmitter()
    const child = Object.assign(emitter, {
      stdin: new PassThrough(),
      stdout: Object.assign(new PassThrough(), { setEncoding: vi.fn() }),
      stderr: Object.assign(new PassThrough(), { setEncoding: vi.fn() }),
      killed: false,
      pid: 12345,
      kill: vi.fn(function (this: FakeChild, _signal?: string) {
        this.killed = true
        this.emit('exit', 0, _signal)
      })
    }) as FakeChild
    return child
  }

  return {
    ...actual,
    spawn: vi.fn(() => {
      lastSpawned = makeFakeChild()
      return lastSpawned
    })
  }
})

describe('EmulatorSupervisor', () => {
  let emu: EmulatorSupervisor
  let statuses: EmulatorStatus[]

  beforeEach(() => {
    lastSpawned = null
    emu = new EmulatorSupervisor()
    statuses = []
    emu.on('status', (s: EmulatorStatus) => statuses.push(s))
  })

  it('starts idle', () => {
    expect(emu.getStatus().state).toBe('idle')
  })

  it('transitions to starting then running on start', () => {
    emu.start('/path/to/firmware.bin')
    expect(statuses.map((s) => s.state)).toEqual(['starting', 'running'])
  })

  it('launches an esp32c6 board on qemu-system-riscv32 with no PSRAM args', () => {
    emu.start('/fw.bin', { machine: 'esp32c6', flashSize: '16M' })
    const call = vi.mocked(spawn).mock.calls.at(-1)!
    expect(String(call[0])).toMatch(/qemu-system-riscv32$/)
    const args = call[1] as string[]
    expect(args.slice(0, 3)).toEqual(['-nographic', '-machine', 'esp32c6'])
    expect(args).not.toContain('-m')
    expect(args).not.toContain('-global')
  })

  it('adds the slirp open_eth NIC only when network is "user"', () => {
    emu.start('/fw.bin', { machine: 'esp32s3', network: 'user' })
    const userArgs = vi.mocked(spawn).mock.calls.at(-1)![1] as string[]
    expect(userArgs.join(' ')).toContain('-nic user,model=open_eth')

    emu.stop()
    emu.start('/fw.bin', { machine: 'esp32s3' })
    const noneArgs = vi.mocked(spawn).mock.calls.at(-1)![1] as string[]
    expect(noneArgs).not.toContain('-nic')
  })

  it('adds the UART1 chardev only when a UART1 socket is set and exists', () => {
    const sock = join(tmpdir(), `emu-uart1-${process.pid}.sock`)
    writeFileSync(sock, '')
    try {
      emu.start('/fw.bin', { machine: 'esp32s3' })
      expect(vi.mocked(spawn).mock.calls.at(-1)![1] as string[]).not.toContain('-chardev')
      emu.stop()

      emu.setUart1Socket(sock)
      emu.start('/fw.bin', { machine: 'esp32s3' })
      const args = vi.mocked(spawn).mock.calls.at(-1)![1] as string[]
      expect(args.join(' ')).toContain(
        `-chardev socket,id=pbuart1,path=${sock} -serial chardev:pbuart1`
      )
      // After UART0's mon:stdio, so it lands on serial_hd(1).
      expect(args.indexOf('chardev:pbuart1')).toBeGreaterThan(args.indexOf('mon:stdio'))
      emu.stop()

      rmSync(sock)
      emu.start('/fw.bin', { machine: 'esp32s3' })
      expect(vi.mocked(spawn).mock.calls.at(-1)![1] as string[]).not.toContain('-chardev')
    } finally {
      rmSync(sock, { force: true })
    }
  })

  it('transitions to stopping then idle on stop', () => {
    emu.start('/path/to/firmware.bin')
    statuses.length = 0
    emu.stop()
    expect(statuses[0]!.state).toBe('stopping')
  })

  it('emits serial lines from stdout in batches', async () => {
    const lines: SerialLine[] = []
    emu.on('serial', (batch: SerialLine[]) => lines.push(...batch))
    emu.start('/path/to/firmware.bin')

    lastSpawned!.stdout.emit('data', 'hello world\nfoo bar\n')

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(lines).toHaveLength(2)
    expect(lines[0]!.text).toBe('hello world')
    expect(lines[1]!.text).toBe('foo bar')

    emu.dispose()
  })

  it('strips ANSI from serial output', async () => {
    const lines: SerialLine[] = []
    emu.on('serial', (batch: SerialLine[]) => lines.push(...batch))
    emu.start('/path/to/firmware.bin')

    lastSpawned!.stdout.emit('data', '\x1b[32mOK\x1b[0m\n')

    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(lines[0]!.text).toBe('OK')
    emu.dispose()
  })

  it('writes to stdin', () => {
    emu.start('/path/to/firmware.bin')
    const writeSpy = vi.spyOn(lastSpawned!.stdin, 'write')
    emu.writeSerial('ver')
    expect(writeSpy).toHaveBeenCalledWith('ver\n')
    emu.dispose()
  })

  it('reports crashed when child emits error', () => {
    emu.start('/path/to/firmware.bin')
    statuses.length = 0
    lastSpawned!.kill = vi.fn()
    lastSpawned!.emit('error', new Error('spawn failed'))
    expect(statuses[0]!.state).toBe('crashed')
    expect(statuses[0]!.error).toContain('spawn failed')
  })

  it('reset from idle with a path restarts', () => {
    emu.start('/path/to/firmware.bin')
    statuses.length = 0
    emu.stop()
    // Now idle
    statuses.length = 0
    emu.reset()
    expect(statuses.map((s) => s.state)).toEqual(['starting', 'running'])
    emu.dispose()
  })

  it('reset without a prior path does nothing', () => {
    emu.reset()
    expect(statuses).toHaveLength(0)
  })

  it('reset from crashed restarts', () => {
    emu.start('/path/to/firmware.bin')
    statuses.length = 0
    lastSpawned!.kill = vi.fn()
    lastSpawned!.emit('error', new Error('crash'))
    statuses.length = 0
    emu.reset()
    expect(statuses.map((s) => s.state)).toEqual(['starting', 'running'])
    emu.dispose()
  })

  it('reset while running stops then restarts', () => {
    emu.start('/path/to/firmware.bin')
    statuses.length = 0
    emu.reset()
    // stopping → idle (from kill) → starting → running (from restart)
    expect(statuses.map((s) => s.state)).toEqual(['stopping', 'idle', 'starting', 'running'])
    emu.dispose()
  })

  it('dispose cancels a pending reset restart', () => {
    emu.start('/path/to/firmware.bin')
    // Make kill not emit exit synchronously so we can dispose before restart
    lastSpawned!.kill = vi.fn()
    statuses.length = 0
    emu.reset()
    expect(statuses[0]!.state).toBe('stopping')
    emu.dispose()
    // Simulate the child finally exiting after dispose
    lastSpawned!.emit('exit', 0, 'SIGKILL')
    // Should not have restarted
    expect(statuses.filter((s) => s.state === 'starting')).toHaveLength(0)
  })
})
