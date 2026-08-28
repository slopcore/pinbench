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
        JSON.parse(readFileSync(resolve(__dirname, '../../boards/thinknode-m9-v1.0.board.json'), 'utf8'))
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
          '-machine', 'esp32s3',
          '-m', '8M',
          '-global', 'ssi_psram.is_octal=true',
          '-drive', `file=${IMAGE},if=mtd,format=raw`,
          '-serial', 'mon:stdio',
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
        host as unknown as { devices: Map<string, { model: { id: string; snapshot(): unknown } }> }
      ).devices
      const st = [...devices.values()].find((d) => d.model.id === 'sitronix.st7789')
      expect(st).toBeDefined()
      const snap = st!.model.snapshot() as Record<string, unknown>
      expect(snap['poweredOn']).toBe(true)
      expect(snap['displayOn']).toBe(true)
      expect(snap['bpp']).toBe(16)
      expect((snap['window'] as { w: number }).w).toBeGreaterThan(0)
      expect(framebufferMessages).toBeGreaterThan(0)
      expect(diagnostics.filter((m) => /unimplemented command/i.test(m))).toEqual([])
      expect(diagnostics.filter((m) => /cs-contention|asserted together/i.test(m))).toEqual([])
    })
  }
)
