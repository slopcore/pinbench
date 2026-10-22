// @vitest-environment node
import type { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BuildRunner } from './build'
import type { BuildRunnerDeps } from './build'
import type { BuildStatus } from '../shared/build'

interface FakeChild extends EventEmitter {
  stdout: PassThrough & { setEncoding: () => void }
  stderr: PassThrough & { setEncoding: () => void }
  pid: number
  kill: ReturnType<typeof vi.fn>
  /** argv the runner spawned this child with. */
  args: string[]
  env?: NodeJS.ProcessEnv
}

function makeChild(args: string[] = [], env?: NodeJS.ProcessEnv): FakeChild {
  const child = Object.assign(new EventEmitter(), {
    stdout: Object.assign(new PassThrough(), { setEncoding: (): void => undefined }),
    stderr: Object.assign(new PassThrough(), { setEncoding: (): void => undefined }),
    pid: 4242,
    kill: vi.fn(),
    args,
    env
  }) as FakeChild
  return child
}

/** Drive a child to completion: emit output, flush the streams, exit, close. */
function finish(child: FakeChild, stdout: string, code: number): void {
  if (stdout) child.stdout.emit('data', stdout)
  child.stdout.emit('end')
  child.stderr.emit('end')
  child.emit('exit', code, null)
  child.emit('close', code, null)
}

const CACHE = join('/cache')
const PROJECT_CONFIG = { envs: ['esp32s3'], options: { esp32s3: {} } }

function makeRunner(overrides: Partial<BuildRunnerDeps> = {}) {
  const spawns: FakeChild[] = []
  const spawn = vi.fn(
    (_cmd: string, args: string[] = [], opts: { env?: NodeJS.ProcessEnv } = {}) => {
      const child = makeChild(args, opts.env)
      spawns.push(child)
      return child as unknown as ReturnType<typeof nodeSpawn>
    }
  )
  const writes: Record<string, string | Uint8Array> = {}
  const runner = new BuildRunner({
    cacheDir: '/cache',
    spawn: spawn as unknown as typeof nodeSpawn,
    writeFile: async (path, data) => {
      writes[path] = data
    },
    readFileMaybe: () => null,
    mkdir: async () => undefined,
    fileExists: () => true,
    mtime: () => 1,
    resolvePio: async () => ({ pio: '/venv/bin/pio', coreDir: '/core' }),
    readProjectConfig: async () => PROJECT_CONFIG,
    ...overrides
  })
  const states: BuildStatus[] = []
  const diagnostics: unknown[] = []
  runner.on('state', (s: BuildStatus) => states.push(s))
  runner.on('diagnostics', (d: unknown) => diagnostics.push(d))
  return { runner, spawns, states, diagnostics, writes, spawn }
}

afterEach(() => vi.restoreAllMocks())

describe('BuildRunner', () => {
  it('runs pio, merges, and reports done with the image path', async () => {
    const { runner, spawns, states, writes } = makeRunner()
    const done = runner.run({ projectDir: '/proj', env: 'esp32s3', emulator: {} })

    await vi.waitFor(() => expect(spawns).toHaveLength(1))
    // The override config was written and passed with -c.
    expect(Object.values(writes)[0]).toContain('board_build.flash_mode = dio')
    finish(spawns[0]!, 'Compiling src/main.cpp.o\nLinking firmware.elf\n', 0)

    await vi.waitFor(() => expect(spawns).toHaveLength(2))
    finish(spawns[1]!, '', 0)

    await done
    const last = states.at(-1)!
    expect(last.state).toBe('done')
    expect(last.image).toBe(join(CACHE, 'proj-esp32s3.bin'))
    expect(last.cached).toBe(false)
    expect(states.map((s) => s.state)).toEqual(
      expect.arrayContaining(['preparing', 'compiling', 'linking', 'merging', 'done'])
    )
  })

  it('sizes the merged image from flashSize and keeps PSRAM octal in the override', async () => {
    const { runner, spawns, writes } = makeRunner()
    const done = runner.run({
      projectDir: '/proj',
      env: 'esp32s3',
      emulator: { flashSize: '16M', psramSize: '8M', psramOctal: true }
    })

    await vi.waitFor(() => expect(spawns).toHaveLength(1))
    expect(Object.values(writes)[0]).toContain('board_build.arduino.memory_type = dio_opi')
    finish(spawns[0]!, 'Compiling src/main.cpp.o\nLinking firmware.elf\n', 0)

    await vi.waitFor(() => expect(spawns).toHaveLength(2))
    const mergeArgs = spawns[1]!.args
    expect(mergeArgs[mergeArgs.indexOf('--flash_size') + 1]).toBe('16MB')
    expect(mergeArgs[mergeArgs.indexOf('--fill-flash-size') + 1]).toBe('16MB')
    finish(spawns[1]!, '', 0)
    await done
  })

  it('builds a pioarduino env in its own core dir, merging with the default core esptool', async () => {
    const { runner, spawns, spawn } = makeRunner({
      readProjectConfig: async () => ({
        envs: ['c6'],
        options: {
          c6: {
            platform:
              'https://github.com/pioarduino/platform-espressif32/releases/download/54.03.21/platform-espressif32.zip'
          }
        }
      })
    })
    const done = runner.run({ projectDir: '/proj', env: 'c6', emulator: { machine: 'esp32c6' } })

    await vi.waitFor(() => expect(spawns).toHaveLength(1))
    const pioEnv = (spawn.mock.calls[0]![2] as { env?: NodeJS.ProcessEnv }).env
    expect(pioEnv?.['PLATFORMIO_CORE_DIR']).toBe('/core-pioarduino')
    finish(spawns[0]!, 'Compiling src/main.cpp.o\nLinking firmware.elf\n', 0)

    await vi.waitFor(() => expect(spawns).toHaveLength(2))
    const mergeArgs = spawns[1]!.args
    expect(mergeArgs[0]).toBe(join('/core', 'packages', 'tool-esptoolpy', 'esptool.py'))
    expect(mergeArgs[mergeArgs.indexOf('--chip') + 1]).toBe('esp32c6')
    expect(mergeArgs).toContain(
      join(
        '/core-pioarduino',
        'packages',
        'framework-arduinoespressif32',
        'tools',
        'partitions',
        'boot_app0.bin'
      )
    )
    finish(spawns[1]!, '', 0)
    await done
  })

  it('leaves the core dir alone for the official platform', async () => {
    const { runner, spawns, spawn } = makeRunner()
    const done = runner.run({ projectDir: '/proj', env: 'esp32s3', emulator: {} })
    await vi.waitFor(() => expect(spawns).toHaveLength(1))
    expect((spawn.mock.calls[0]![2] as { env?: NodeJS.ProcessEnv }).env).toBeUndefined()
    finish(spawns[0]!, 'Compiling src/main.cpp.o\nLinking firmware.elf\n', 0)
    await vi.waitFor(() => expect(spawns).toHaveLength(2))
    finish(spawns[1]!, '', 0)
    await done
  })

  it('injects PINBENCH_EMULATED_NET, linker wraps, and runtime lib dir when network is "user"', async () => {
    const { runner, spawns, spawn } = makeRunner()
    const done = runner.run({
      projectDir: '/proj',
      env: 'esp32s3',
      emulator: { network: 'user' }
    })

    await vi.waitFor(() => expect(spawns).toHaveLength(1))
    const pioEnv = (spawn.mock.calls[0]![2] as { env?: NodeJS.ProcessEnv }).env
    expect(pioEnv?.['PLATFORMIO_BUILD_FLAGS']).toContain('-DPINBENCH_EMULATED_NET=1')
    expect(pioEnv?.['PLATFORMIO_BUILD_FLAGS']).toContain('-Wl,--wrap=esp_wifi_init')
    expect(pioEnv?.['PLATFORMIO_BUILD_FLAGS']).toContain('-Wl,--wrap=esp_wifi_start')
    expect(pioEnv?.['PLATFORMIO_LIB_EXTRA_DIRS']).toContain('runtime')
    finish(spawns[0]!, 'Compiling src/main.cpp.o\nLinking firmware.elf\n', 0)
    await vi.waitFor(() => expect(spawns).toHaveLength(2))
    finish(spawns[1]!, '', 0)
    await done
  })

  it('leaves the pio env untouched when network is not "user"', async () => {
    const { runner, spawns, spawn } = makeRunner()
    const done = runner.run({ projectDir: '/proj', env: 'esp32s3', emulator: {} })
    await vi.waitFor(() => expect(spawns).toHaveLength(1))
    expect(spawn.mock.calls[0]![2] as { env?: unknown }).not.toHaveProperty('env')
    finish(spawns[0]!, 'Compiling src/main.cpp.o\nLinking firmware.elf\n', 0)
    await vi.waitFor(() => expect(spawns).toHaveLength(2))
    finish(spawns[1]!, '', 0)
    await done
  })

  it('never writes into the project checkout — the source belongs to the IDE', async () => {
    const { runner, spawns, writes } = makeRunner()
    const done = runner.run({ projectDir: '/proj', env: 'esp32s3', emulator: {} })
    await vi.waitFor(() => expect(spawns).toHaveLength(1))
    finish(spawns[0]!, 'Compiling src/main.cpp.o\nLinking firmware.elf\n', 0)
    await vi.waitFor(() => expect(spawns).toHaveLength(2))
    finish(spawns[1]!, '', 0)
    await done
    expect(Object.keys(writes).filter((path) => path.startsWith('/proj'))).toEqual([])
  })

  it('surfaces compiler errors as diagnostics and fails', async () => {
    const { runner, spawns, states, diagnostics } = makeRunner()
    const done = runner.run({ projectDir: '/proj', env: 'esp32s3', emulator: {} })

    await vi.waitFor(() => expect(spawns).toHaveLength(1))
    finish(spawns[0]!, "src/main.cpp:12:3: error: expected ';'\n", 1)

    await done
    expect(states.at(-1)!.state).toBe('failed')
    expect(diagnostics).toHaveLength(1)
    expect((diagnostics[0] as { severity: string }[])[0]!.severity).toBe('error')
    // No merge was attempted.
    expect(spawns).toHaveLength(1)
  })

  it('rejects an environment that is not in the project', async () => {
    const { runner, states } = makeRunner()
    await runner.run({ projectDir: '/proj', env: 'nope', emulator: {} })
    expect(states.at(-1)!.state).toBe('failed')
    expect(states.at(-1)!.error).toMatch(/not in platformio\.ini/)
  })

  it('skips the merge when the image is current and nothing recompiled', async () => {
    const { runner, spawns, states } = makeRunner({
      // image mtime (10) newer than firmware.bin mtime (1)
      mtime: (path: string) => (path.endsWith('proj-esp32s3.bin') ? 10 : 1)
    })
    const done = runner.run({ projectDir: '/proj', env: 'esp32s3', emulator: {} })

    await vi.waitFor(() => expect(spawns).toHaveLength(1))
    finish(spawns[0]!, 'Linking firmware.elf\n', 0) // no "Compiling" line

    await done
    expect(spawns).toHaveLength(1) // esptool never spawned
    expect(states.at(-1)!.state).toBe('done')
    expect(states.at(-1)!.cached).toBe(true)
  })

  it('cancels a running build', async () => {
    const { runner, spawns, states } = makeRunner()
    const done = runner.run({ projectDir: '/proj', env: 'esp32s3', emulator: {} })
    await vi.waitFor(() => expect(spawns).toHaveLength(1))

    runner.cancel()
    spawns[0]!.emit('exit', null, 'SIGTERM')
    spawns[0]!.emit('close', null, 'SIGTERM')

    await done
    expect(states.at(-1)!.state).toBe('cancelled')
  })

  it('refuses a second run while one is still preparing', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { runner, spawns } = makeRunner({
      resolvePio: async () => {
        await gate
        return { pio: '/venv/bin/pio', coreDir: '/core' }
      }
    })
    const first = runner.run({ projectDir: '/proj', env: 'esp32s3', emulator: {} })
    await expect(runner.run({ projectDir: '/proj', env: 'esp32s3', emulator: {} })).rejects.toThrow(
      /already running/
    )
    release()
    await vi.waitFor(() => expect(spawns).toHaveLength(1))
    finish(spawns[0]!, 'Compiling main.cpp.o\nLinking firmware.elf\n', 0)
    await vi.waitFor(() => expect(spawns).toHaveLength(2))
    finish(spawns[1]!, '', 0)
    await first
  })

  it('honours a cancel issued during the preparing window', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { runner, spawns, states } = makeRunner({
      resolvePio: async () => {
        await gate
        return { pio: '/venv/bin/pio', coreDir: '/core' }
      }
    })
    const done = runner.run({ projectDir: '/proj', env: 'esp32s3', emulator: {} })
    runner.cancel()
    release()
    await done
    expect(spawns).toHaveLength(0) // never got to pio run
    expect(states.at(-1)!.state).toBe('cancelled')
  })

  it('injects wifi wrap flags and extra scripts when network is user', async () => {
    const { runner, spawns } = makeRunner()
    const done = runner.run({
      projectDir: '/proj',
      env: 'esp32s3',
      emulator: { network: 'user' }
    })
    await vi.waitFor(() => expect(spawns).toHaveLength(1))
    const spawnEnv = spawns[0]!.env!
    expect(spawnEnv['PLATFORMIO_BUILD_FLAGS']).toContain('-DPINBENCH_EMULATED_NET=1')
    expect(spawnEnv['PLATFORMIO_EXTRA_SCRIPTS']).toContain('pinbench_wifi_shim.py')
    expect(spawnEnv['PINBENCH_RUNTIME_DIR']).toBeDefined()
    expect(spawnEnv['PLATFORMIO_LIB_EXTRA_DIRS']).toBeDefined()
    finish(spawns[0]!, 'Compiling main.cpp.o\nLinking firmware.elf\n', 0)
    await vi.waitFor(() => expect(spawns).toHaveLength(2))
    finish(spawns[1]!, '', 0)
    await done
  })

  it('handles non-ESP32 (nRF52840) builds by converting produced hex to padded image without merge', async () => {
    const { runner, spawns, states, writes } = makeRunner({
      readProjectConfig: async () => ({ envs: ['nrf52_env'], options: { nrf52_env: {} } }),
      fileExists: (p) => !p.includes('bootloader.bin') && !p.includes('partitions.bin'),
      readFileMaybe: () => ':020000040000FA\n:04000000112233444E\n:00000001FF\n'
    })
    const done = runner.run({
      projectDir: '/proj',
      env: 'nrf52_env',
      emulator: { machine: 'esp32s3', flashSize: '2M' }
    })
    await vi.waitFor(() => expect(spawns).toHaveLength(1))
    finish(spawns[0]!, 'Linking firmware.elf\nBuilding firmware.hex\n', 0)
    await done
    expect(spawns).toHaveLength(1) // esptool merge never spawned
    expect(states.at(-1)!.state).toBe('done')
    const writtenImage = writes['/cache/proj-nrf52_env.bin']
    expect(writtenImage).toBeDefined()
    expect(writtenImage!.length).toBe(2 * 1024 * 1024)
  })
})
