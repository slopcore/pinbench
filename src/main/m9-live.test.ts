// @vitest-environment node
/**
 * Live end-to-end for the ThinkNode M9 (roadmap M9 / M7 radio): boot a real
 * MeshCore `ThinkNode_M9_repeater_` image under the PinBench-patched QEMU with
 * the real `DeviceHost`, then inject an incoming radio frame from the LR1110 IN
 * panel's code path and assert the firmware receives it.
 *
 * Sibling of `heltec-live.test.ts`. The M9 differences:
 *   - octal PSRAM: `-m 8M -global ssi_psram.is_octal=true` (Heltec has none);
 *   - the LR1110 model in place of the SX1262, on the shared `spi0` bus behind
 *     NSS (GPIO39), with BUSY (GPIO41) and DIO9/IRQ (GPIO42) as discrete lines;
 *   - a slightly longer boot: measured at ~6.5 s warm, ~10.5 s on a fresh flash
 *     (the extra ~3.6 s is a one-time `SPIFFS.begin(true)` format of the empty
 *     partition). Not the "~2.5 min" the roadmap once claimed — that was never
 *     measured, just this wait constant. `PINBENCH_M9_BOOT_MS` overrides it.
 *     There is no I2C-scan pathology: the fork's S3 machine models no I2C
 *     peripheral, so MeshCore's 112-address scan just eats ~112 × 50 ms of
 *     `Wire` timeout and is invisible against the radio/FS init. Full phase
 *     breakdown: `src/main/m9-trace.test.ts`.
 *
 * What it proves, in order:
 *   1. the firmware boots past `radio_init()` — the LR1110 `getVersion`
 *      handshake and the modem-config opcodes all land on the model, so
 *      `radio.begin()` returns `RADIOLIB_ERR_NONE` and the repeater prints its
 *      identity ("Repeater ID:"). This is the fix for the long-standing `-707`;
 *   2. `Op.Hello` hands the guest an input-pin mask covering BUSY / DIO9;
 *   3. an injected `channel` frame raises RxDone on the model and drives DIO9;
 *   4. the firmware's GPIO ISR runs, services the receive and clears the IRQ
 *      (the model drives DIO9 back low), so the packet made it end to end.
 *
 * Skipped unless `PINBENCH_LIVE_QEMU=1` and `PINBENCH_M9_IMAGE` points at a
 * merged 16 MB flash image (Build & flash produces one; by hand it is
 * `pio run -e ThinkNode_M9_repeater_` with the DIO / `dio_opi` override from
 * `src/shared/pio.ts`, then `esptool merge_bin --fill-flash-size 16MB`).
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DeviceHost } from './devices'
import { parseBoard } from '../shared/board'
import { Op } from '../shared/devices/protocol'

const LIVE = process.env['PINBENCH_LIVE_QEMU'] === '1'
const IMAGE = process.env['PINBENCH_M9_IMAGE'] ?? ''
const CONTROL = process.env['PINBENCH_CONTROL'] === '1'
const QEMU = resolve(__dirname, '../../.qemu/build/qemu-system-xtensa')
const BOARD = resolve(__dirname, '../../boards/thinknode-m9-v1.0.board.json')

const BOOT_MS = Number(process.env['PINBENCH_M9_BOOT_MS'] ?? 30_000)
const POST_MS = Number(process.env['PINBENCH_M9_POST_MS'] ?? 15_000)

describe.skipIf(!LIVE || !IMAGE || !existsSync(IMAGE) || !existsSync(QEMU))(
  'M9 live: LR1110 frame injection reaches the firmware',
  () => {
    const host = new DeviceHost()
    let serial = ''
    let child: ReturnType<typeof spawn> | null = null
    let helloMask: number[] = []
    let injected = false
    const eventsPost: string[] = []
    const gpioReadPost = new Map<number, number>()

    beforeAll(
      async () => {
        const board = parseBoard(JSON.parse(readFileSync(BOARD, 'utf8')))
        host.load(board)
        host.on('event', (m: { partId: string; event: { kind: string; summary: string } }) => {
          if (injected) eventsPost.push(`${m.partId} ${m.event.kind} ${m.event.summary}`)
        })
        const orig = host.handleFrame.bind(host)
        ;(host as unknown as { handleFrame: typeof orig }).handleFrame = (f) => {
          if (injected && f.op === Op.GpioRead) {
            gpioReadPost.set(f.select, (gpioReadPost.get(f.select) ?? 0) + 1)
          }
          const reply = orig(f)
          if (f.op === Op.Hello && reply) helloMask = [...reply.subarray(20)]
          return reply
        }

        const sock = join(tmpdir(), `m9-live-${process.pid}.sock`)
        await host.listen(sock)
        // Octal PSRAM (8 MB) + 16 MB flash — the M9's `emulator` block. Unlike the
        // Heltec spawn, `-m` / `ssi_psram.is_octal` are required; omitting them
        // asserts in `do_core_init`.
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
          {
            env: { ...process.env, PINBENCH_DEVICE_SOCKET: sock },
            stdio: ['ignore', 'pipe', 'pipe']
          }
        )
        child.stdout?.on('data', (d: Buffer) => (serial += d.toString()))
        child.stderr?.on('data', (d: Buffer) => (serial += d.toString()))

        // Boot to the main loop (radio_init, identity, sensor scan, FS format), then
        // inject.
        await new Promise((r) => setTimeout(r, BOOT_MS))
        injected = true
        if (!CONTROL) {
          host.command('u2', 'inject', {
            kind: 'channel',
            text: 'trailhead in 20',
            rssi: -72,
            snr: 9
          })
        }
        await new Promise((r) => setTimeout(r, POST_MS))
      },
      BOOT_MS + POST_MS + 45_000
    )

    afterAll(async () => {
      child?.kill('SIGKILL')
      await host.dispose()
    })

    it('boots the repeater firmware past radio_init to its main loop', () => {
      expect(serial).not.toMatch(/radio init failed/i)
      expect(serial).toContain('Repeater ID:')
    })

    it('hands the guest an input mask covering the LR1110 BUSY / DIO9 pins', () => {
      // GPIO41 (BUSY) and GPIO42 (DIO9) → mask byte 5, bits 1 and 2 → 0x06.
      expect(helloMask[5]! & 0x06).toBe(0x06)
    })

    it.skipIf(CONTROL)('the injected frame raises RxDone and drives DIO9', () => {
      expect(eventsPost.some((e) => /^u2 rx RX channel/.test(e))).toBe(true)
      expect(eventsPost.some((e) => e === 'u2 drive IRQ → 1')).toBe(true)
    })

    it.skipIf(CONTROL)('the firmware services the receive and clears the IRQ', () => {
      // The guest keeps polling DIO9 (GPIO42) after the inject — not wedged…
      expect(gpioReadPost.get(42) ?? 0).toBeGreaterThan(20)
      // …and its ISR runs the RX path, which ends in a CLEAR_IRQ that drops the
      // line: an IRQ→1 followed by an IRQ→0 in the post-inject events.
      const up = eventsPost.indexOf('u2 drive IRQ → 1')
      const down = eventsPost.lastIndexOf('u2 drive IRQ → 0')
      expect(up).toBeGreaterThanOrEqual(0)
      expect(down).toBeGreaterThan(up)
    })
  }
)
