// @vitest-environment node
import type { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { UsbFlashRunner } from './usb-flash'
import type { UsbFlashRunnerDeps } from './usb-flash'
import type { UsbFlashStatus } from '../shared/usb-flash'
import type { BuildOutputLine } from '../shared/build'
import type { UsbFlashRequest } from '../shared/ipc'

interface FakeChild extends EventEmitter {
  stdout: PassThrough & { setEncoding: () => void }
  stderr: PassThrough & { setEncoding: () => void }
  pid: number
  kill: ReturnType<typeof vi.fn>
  args: string[]
}

function makeChild(args: string[]): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdout: Object.assign(new PassThrough(), { setEncoding: (): void => undefined }),
    stderr: Object.assign(new PassThrough(), { setEncoding: (): void => undefined }),
    pid: 4242,
    kill: vi.fn(),
    args
  }) as FakeChild
}

function finish(child: FakeChild, stdout: string, code: number): void {
  if (stdout) child.stdout.emit('data', stdout)
  child.stdout.emit('end')
  child.stderr.emit('end')
  child.emit('exit', code, null)
  child.emit('close', code, null)
}

function makeRunner(overrides: Partial<UsbFlashRunnerDeps> = {}) {
  const spawns: FakeChild[] = []
  const spawn = vi.fn((_cmd: string, args: string[] = []) => {
    const child = makeChild(args)
    spawns.push(child)
    return child as unknown as ReturnType<typeof nodeSpawn>
  })
  const writes: Record<string, string> = {}
  const runner = new UsbFlashRunner({
    userDataDir: '/u',
    cacheDir: '/cache',
    spawn: spawn as unknown as typeof nodeSpawn,
    fileExists: () => true,
    writeFile: async (path, data) => {
      writes[path] = data
    },
    mkdir: async () => undefined,
    resolvePio: async () => ({ pio: '/venv/bin/pio', coreDir: '/core' }),
    readProjectConfig: async () => ({ envs: ['esp32s3'], options: { esp32s3: {} } }),
    listPorts: async () => [{ port: '/dev/ttyUSB0', description: 'board', hwid: 'x' }],
    ...overrides
  })
  const states: UsbFlashStatus[] = []
  const output: BuildOutputLine[] = []
  runner.on('state', (s: UsbFlashStatus) => states.push(s))
  runner.on('output', (l: BuildOutputLine) => output.push(l))
  return { runner, spawns, states, output, writes }
}

/** `.pio` build tree the USB path uses — PinBench cache, not `.pio/build`. */
const USB_BUILD_DIR = '/cache/usb-build/p/esp32s3'

const REQUEST: UsbFlashRequest = {
  projectDir: '/p',
  env: 'esp32s3',
  port: '/dev/ttyUSB0',
  mode: 'flash',
  chip: 'esp32s3'
}

/** Flush pending microtasks — robust to however many awaits `run()` chains. */
async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/** Wait until at least `n` children have been spawned, then return the nth-1. */
async function nthSpawn(spawns: FakeChild[], n: number): Promise<FakeChild> {
  for (let i = 0; i < 50 && spawns.length < n; i++) await flush(4)
  if (spawns.length < n) throw new Error(`only ${spawns.length} spawns, wanted ${n}`)
  return spawns[n - 1]!
}

/**
 * Finish spawned children in order as they appear, until `run` settles. Robust
 * to however many child processes the pipeline chains.
 */
async function driveUntil(run: Promise<unknown>, spawns: FakeChild[], code = 0): Promise<void> {
  let settled = false
  void run.finally(() => {
    settled = true
  })
  let i = 0
  for (let guard = 0; guard < 200 && !settled; guard++) {
    if (spawns[i]) {
      finish(spawns[i]!, '', code)
      i++
    }
    await flush(3)
  }
  await run
}

describe('UsbFlashRunner', () => {
  it('flash mode: builds board-native into the cache tree, then write_flash', async () => {
    const { runner, spawns, states, writes } = makeRunner()
    const run = runner.run(REQUEST)

    // First spawn is the build, with a -c override that only redirects build_dir.
    const build = await nthSpawn(spawns, 1)
    expect(build.args.slice(0, 3)).toEqual(['run', '-d', '/p'])
    expect(build.args).toContain('-c')
    const override = Object.values(writes)[0]!
    expect(override).toContain('build_dir = /cache/usb-build/p')
    expect(override).not.toContain('flash_mode')
    finish(build, 'ok', 0)

    // No erase; straight to write_flash of the cache-tree artifacts.
    const write = await nthSpawn(spawns, 2)
    expect(write.args).toContain('write_flash')
    expect(write.args).not.toContain('erase_flash')
    expect(write.args).not.toContain('--fill-flash-size')
    expect(write.args[write.args.indexOf('--port') + 1]).toBe('/dev/ttyUSB0')
    expect(write.args).toContain(`${USB_BUILD_DIR}/firmware.bin`)
    finish(write, 'Hash of data verified.', 0)
    await run

    expect(states.map((s) => s.state)).toEqual(['building', 'flashing', 'done'])
  })

  it('erase-flash mode: erase_flash runs before write_flash', async () => {
    const { runner, spawns, states } = makeRunner()
    const run = runner.run({ ...REQUEST, mode: 'erase-flash' })
    await driveUntil(run, spawns) // build → erase → write, in sequence

    expect(spawns[1]!.args).toContain('erase_flash')
    expect(spawns[2]!.args).toContain('write_flash')
    expect(states.map((s) => s.state)).toEqual(['building', 'erasing', 'flashing', 'done'])
  })

  it('fails when the board-native build fails, and does not flash', async () => {
    const { runner, spawns, states } = makeRunner()
    const run = runner.run(REQUEST)
    const build = await nthSpawn(spawns, 1)
    finish(build, 'compile error', 1)
    await run

    expect(spawns).toHaveLength(1)
    expect(states.at(-1)?.state).toBe('failed')
  })

  it('reports esptool progress as percent while flashing', async () => {
    const { runner, spawns, states } = makeRunner()
    const run = runner.run(REQUEST)
    finish(await nthSpawn(spawns, 1), '', 0)
    const write = await nthSpawn(spawns, 2)
    write.stdout.emit('data', 'Writing at 0x00010000... (42 %)\n')
    await flush()
    expect(states.some((s) => s.percent === 42)).toBe(true)
    finish(write, '', 0)
    await run
  })

  it('rejects a second run while one is in flight', async () => {
    const { runner, spawns } = makeRunner()
    const run = runner.run(REQUEST)
    await expect(runner.run(REQUEST)).rejects.toThrow(/already running/)
    await driveUntil(run, spawns)
  })
})
