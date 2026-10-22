// @vitest-environment node
/**
 * Live end-to-end: boot a real MeshCore Heltec Wireless Paper repeater under the
 * PinBench-patched QEMU with the real `DeviceHost`, then inject an incoming
 * radio frame from the SX1262 IN panel's code path and assert the firmware
 * receives it.
 *
 * Skipped unless `PINBENCH_LIVE_QEMU=1` and `PINBENCH_HELTEC_IMAGE` points at a
 * merged flash image built for the emulator (PinBench's Build & flash produces
 * one; by hand it is `pio run -e Heltec_Wireless_Paper_repeater` with the
 * `board_build.flash_mode = dio` / `memory_type = dio_qspi` override from
 * `src/shared/pio.ts`, then `esptool merge_bin --fill-flash-size 8MB`). Same
 * gating rationale as `live-bridge.test.ts` — needs the built emulator and a
 * firmware artifact, so it never runs in the normal suite.
 *
 * What it proves, in order:
 *   1. the firmware boots past `radio_init()` to its main loop ("Repeater ID");
 *   2. `Op.Hello` hands the guest the input-pin mask covering the SX1262's
 *      BUSY (GPIO13) and DIO1 (GPIO14);
 *   3. an injected `channel` frame reaches the model, which raises RxDone and
 *      drives DIO1 high;
 *   4. the fork's GPIO edge-latch turns that into a guest GPIO interrupt, so
 *      MeshCore's dispatcher wakes and reads the frame off the radio — visible
 *      as `GET_RX_BUFFER_STATUS` (0x13) + `READ_BUFFER` (0x1e) SPI opcodes in
 *      the post-inject traffic, which never appear in the control run.
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
const IMAGE = process.env['PINBENCH_HELTEC_IMAGE'] ?? ''
const CONTROL = process.env['PINBENCH_CONTROL'] === '1'
const QEMU = resolve(__dirname, '../../.qemu/build/qemu-system-xtensa')
const BOARD = resolve(__dirname, '../../boards/heltec-wireless-paper-v1.1.board.json')

const OP_GET_RX_BUFFER_STATUS = 0x13
const OP_READ_BUFFER = 0x1e

describe.skipIf(!LIVE || !IMAGE || !existsSync(IMAGE) || !existsSync(QEMU))(
  'Heltec live: SX1262 frame injection reaches the firmware',
  () => {
    const host = new DeviceHost()
    let serial = ''
    let child: ReturnType<typeof spawn> | null = null
    let helloMask: number[] = []
    let injected = false
    const eventsPost: string[] = []
    const postOpHist = new Map<number, number>()
    const gpioReadPost = new Map<number, number>()

    beforeAll(async () => {
      const board = parseBoard(JSON.parse(readFileSync(BOARD, 'utf8')))
      host.load(board)
      host.on('event', (m: { partId: string; event: { kind: string; summary: string } }) => {
        if (injected) eventsPost.push(`${m.partId} ${m.event.kind} ${m.event.summary}`)
      })
      const orig = host.handleFrame.bind(host)
      ;(host as unknown as { handleFrame: typeof orig }).handleFrame = (f) => {
        if (injected && f.op === Op.Xfer && f.payload.length > 0) {
          const op = f.payload[0]!
          postOpHist.set(op, (postOpHist.get(op) ?? 0) + 1)
        }
        if (injected && f.op === Op.GpioRead) {
          gpioReadPost.set(f.select, (gpioReadPost.get(f.select) ?? 0) + 1)
        }
        const reply = orig(f)
        if (f.op === Op.Hello && reply) helloMask = [...reply.subarray(20)]
        return reply
      }

      const sock = join(tmpdir(), `heltec-live-${process.pid}.sock`)
      await host.listen(sock)
      // Heltec Wireless Paper has no PSRAM: match the board's `emulator` block
      // (machine + flashSize only). Forcing `-m` / octal PSRAM asserts in
      // `do_core_init`.
      child = spawn(
        QEMU,
        [
          '-nographic',
          '-machine',
          'esp32s3',
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

      // Boot to the main loop (radio_init, identity, "Repeater ID"), then inject.
      await new Promise((r) => setTimeout(r, 20_000))
      injected = true
      if (!CONTROL) {
        host.command('u2', 'inject', {
          kind: 'channel',
          text: 'trailhead in 20',
          rssi: -72,
          snr: 9
        })
      }
      await new Promise((r) => setTimeout(r, 12_000))
    }, 45_000)

    afterAll(async () => {
      child?.kill('SIGKILL')
      await host.dispose()
    })

    it('boots the repeater firmware to its main loop', () => {
      expect(serial).toContain('Repeater ID:')
      expect(serial).not.toMatch(/Radio init failed/i)
    })

    it('hands the guest an input mask covering the SX1262 BUSY / DIO1 pins', () => {
      // GPIO13 (BUSY) and GPIO14 (DIO1) → byte 1, bits 5 and 6 → 0x60.
      expect(helloMask[1]! & 0x60).toBe(0x60)
    })

    it.skipIf(CONTROL)('the injected frame raises RxDone and drives DIO1', () => {
      expect(eventsPost.some((e) => /^u2 rx RX channel/.test(e))).toBe(true)
      expect(eventsPost.some((e) => e === 'u2 drive DIO1 → 1')).toBe(true)
    })

    it.skipIf(CONTROL)('the firmware wakes and reads the frame off the radio', () => {
      // The guest keeps polling GPIO14 after the inject — it is not wedged.
      expect(gpioReadPost.get(14) ?? 0).toBeGreaterThan(100)
      // …and the dispatcher pulls the packet: buffer-status + buffer-read
      // opcodes that the control run never issues.
      expect(postOpHist.get(OP_GET_RX_BUFFER_STATUS) ?? 0).toBeGreaterThan(0)
      expect(postOpHist.get(OP_READ_BUFFER) ?? 0).toBeGreaterThan(0)
    })
  }
)
