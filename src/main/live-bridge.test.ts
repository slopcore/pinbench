// @vitest-environment node
/**
 * M6.3 — the C bridge against a live guest. Skipped unless `PINBENCH_LIVE_QEMU=1`
 * and `PINBENCH_M9_IMAGE` points at a merged MeshCore M9 flash image (build one
 * with the DIO `dio_opi` override and a 16 M merge — see ROADMAP M6.2). It
 * boots that image under the PinBench-patched `.qemu` with the real
 * `DeviceHost` on the other end of `PINBENCH_DEVICE_SOCKET` and asserts the
 * ST7789 model tracks MeshCore's display bring-up.
 *
 * It needs the built emulator and a firmware artifact, so it never runs in the
 * normal suite — the same reason `spike/` is not unit-tested.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DeviceHost } from './devices'
import { parseBoard } from '../shared/board'
import { Op } from '../shared/devices/protocol'

const LIVE = process.env['PINBENCH_LIVE_QEMU'] === '1'
const IMAGE = process.env['PINBENCH_M9_IMAGE'] ?? ''
const QEMU = resolve(__dirname, '../../.qemu/build/qemu-system-xtensa')

describe.skipIf(!LIVE || !IMAGE || !existsSync(IMAGE) || !existsSync(QEMU))(
  'M6.3 — live GP-SPI2 / GPIO bridge',
  () => {
    const host = new DeviceHost()
    const counts: Record<string, number> = { Hello: 0, Xfer: 0, Gpio: 0, Signal: 0, Reset: 0 }
    const diagnostics: string[] = []
    let framebufferMessages = 0
    let child: ReturnType<typeof spawn> | null = null

    beforeAll(async () => {
      const board = parseBoard(
        JSON.parse(
          readFileSync(resolve(__dirname, '../../boards/thinknode-m9-v1.0.board.json'), 'utf8')
        )
      )
      host.load(board)
      host.on('diagnostic', (d: { message: string }) => diagnostics.push(d.message))
      host.on('framebuffer', () => (framebufferMessages += 1))

      const byOp: Record<number, string> = {
        [Op.Hello]: 'Hello',
        [Op.Xfer]: 'Xfer',
        [Op.Gpio]: 'Gpio',
        [Op.Signal]: 'Signal',
        [Op.Reset]: 'Reset'
      }
      const orig = host.handleFrame.bind(host)
      ;(host as unknown as { handleFrame: typeof orig }).handleFrame = (frame) => {
        counts[byOp[frame.op] ?? 'other'] = (counts[byOp[frame.op] ?? 'other'] ?? 0) + 1
        return orig(frame)
      }

      const sock = join(tmpdir(), `m63-test-${process.pid}.sock`)
      await host.listen(sock)
      child = spawn(
        QEMU,
        [
          '-nographic',
          '-machine',
          'esp32s3',
          '-m',
          '8M',
          '-global',
          'ssi_psram.is_octal=true',
          '-drive',
          `file=${IMAGE},if=mtd,format=raw`,
          '-serial',
          'mon:stdio',
          '-no-reboot'
        ],
        { env: { ...process.env, PINBENCH_DEVICE_SOCKET: sock }, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      // Wait for the guest to connect and run its display init, not a fixed
      // sleep — QEMU cold-start jitter otherwise makes this flaky. MeshCore
      // halts at radio_init a few hundred ms in, so traffic plateaus quickly.
      const deadline = Date.now() + 25_000
      while (Date.now() < deadline && ((counts.Hello ?? 0) === 0 || (counts.Xfer ?? 0) < 200)) {
        await new Promise((r) => setTimeout(r, 500))
      }
      await new Promise((r) => setTimeout(r, 1_000))
    }, 30_000)

    afterAll(async () => {
      child?.kill('SIGTERM')
      await host.dispose()
    })

    it('completes the Hello handshake and carries GPIO + SPI traffic', () => {
      expect(counts.Hello).toBe(1)
      expect(counts.Gpio).toBeGreaterThan(10)
      expect(counts.Xfer).toBeGreaterThan(100)
      // Reset is a once-per-boot frame, never a per-write artifact.
      expect(counts.Reset).toBeLessThanOrEqual(1)
    })

    it('drives the ST7789 model through MeshCore init, contention-free', () => {
      const devices = (
        host as unknown as {
          devices: Map<
            string,
            { model: { id: string; snapshot(): unknown; meter(id: string): number | undefined } }
          >
        }
      ).devices
      const st = [...devices.values()].find((d) => d.model.id === 'sitronix.st7789')
      expect(st).toBeDefined()
      const snap = st!.model.snapshot() as Record<string, unknown>
      expect(snap['poweredOn']).toBe(true)
      expect(snap['displayOn']).toBe(true)
      expect(snap['bpp']).toBe(16)
      expect(snap['inverted']).toBe(true) // MeshCore runs the panel inverted
      // The M9's backlight is active-low; the board's deviceOptions say so, so
      // the panel reads as lit even though the guest never toggles GPIO17.
      expect(snap['backlightOn']).toBe(true)
      expect((snap['window'] as { w: number }).w).toBeGreaterThan(0)
      expect(framebufferMessages).toBeGreaterThan(0)
      // The flush meter is a whole-frame span now, not the tail of ~240 per-row
      // RAMWRs — a real MeshCore frame streams in single-digit ms, never seconds.
      const flush = st!.model.meter('flush') ?? 0
      expect(flush).toBeGreaterThan(0)
      expect(flush).toBeLessThan(1000)
      expect(diagnostics.filter((m) => /unimplemented command/i.test(m))).toEqual([])
      expect(diagnostics.filter((m) => /cs-contention|asserted together/i.test(m))).toEqual([])
      // dc powers on in command mode, so the first transfer is not a stray byte.
      expect(diagnostics.filter((m) => /no command context/i.test(m))).toEqual([])
    })
  }
)

/**
 * M7.2 — the host→guest GPIO input read against a live guest. Same gating as
 * above (`PINBENCH_LIVE_QEMU=1`, `PINBENCH_M9_IMAGE`).
 *
 * What this proves: the `Op.Hello` reply hands the guest the 8-byte input-pin
 * mask, and the patched `esp32_gpio.c` routes `GPIO_IN1` reads of the masked
 * LR1110 lines (BUSY 41, DIO9 42) through `Op.GpioRead` to `DeviceHost`, which
 * answers from `pinLevels`. Verified live: the mask arrives as
 * `0x0000060000000000` and both pins are read over the bridge.
 *
 * What it does NOT yet prove — and why it is carried to **M7.2b**: MeshCore's
 * `radio_init()` still fails `-707` before it clocks a single SPI byte to the
 * radio, stopped by a pre-existing GPIO fault in the espressif fork (the
 * `__pinMode(): Invalid pin selected` / `gpio_set_level(227)` errors first
 * seen in M6.2 and never chased down). The LR1110 model therefore receives no
 * bus traffic in this run — the blocker is upstream of it, in the fork's GPIO
 * model, not in M7.1/M7.2 code.
 */
describe.skipIf(!LIVE || !IMAGE || !existsSync(IMAGE) || !existsSync(QEMU))(
  'M7.2 — host→guest line reads (LR1110 BUSY / DIO9)',
  () => {
    const host = new DeviceHost()
    let serial = ''
    let child: ReturnType<typeof spawn> | null = null
    const gpioReadPins = new Set<number>()
    let helloMask: number[] = []

    beforeAll(async () => {
      const board = parseBoard(
        JSON.parse(
          readFileSync(resolve(__dirname, '../../boards/thinknode-m9-v1.0.board.json'), 'utf8')
        )
      )
      host.load(board)
      const orig = host.handleFrame.bind(host)
      ;(host as unknown as { handleFrame: typeof orig }).handleFrame = (f) => {
        if (f.op === Op.GpioRead) gpioReadPins.add(f.select)
        const reply = orig(f)
        if (f.op === Op.Hello && reply) helloMask = [...reply.subarray(20)]
        return reply
      }
      const sock = join(tmpdir(), `m72-test-${process.pid}.sock`)
      await host.listen(sock)
      child = spawn(
        QEMU,
        [
          '-nographic',
          '-machine',
          'esp32s3',
          '-m',
          '8M',
          '-global',
          'ssi_psram.is_octal=true',
          '-drive',
          `file=${IMAGE},if=mtd,format=raw`,
          '-serial',
          'mon:stdio',
          '-no-reboot'
        ],
        { env: { ...process.env, PINBENCH_DEVICE_SOCKET: sock }, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      child.stdout?.on('data', (d: Buffer) => (serial += d.toString()))
      child.stderr?.on('data', (d: Buffer) => (serial += d.toString()))
      await new Promise((r) => setTimeout(r, 10_000))
    }, 20_000)

    afterAll(async () => {
      child?.kill('SIGKILL')
      await host.dispose()
    })

    it('hands the guest the input-pin mask in the Hello reply (BUSY 41, DIO9 42)', () => {
      // Bits 41 and 42 → byte 5, bits 1 and 2 → 0x06.
      expect(helloMask).toEqual([0, 0, 0, 0, 0, 0x06, 0, 0])
    })

    it('routes GPIO_IN reads of the masked LR1110 lines through Op.GpioRead', () => {
      expect(serial).toContain('input mask 0x0000060000000000')
      expect([...gpioReadPins].sort((a, b) => a - b)).toEqual([41, 42])
    })

    // Carried to M7.2b: radio_init() is blocked by the fork's pre-existing
    // pin-227 GPIO fault, upstream of any LR1110 SPI traffic.
    it.skip('radio_init() succeeds and the LR1110 model reaches LoRa standby', () => {
      expect(serial).not.toMatch(/radio init failed/i)
    })
  }
)
