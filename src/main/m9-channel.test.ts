// @vitest-environment node
/**
 * Live end-to-end for channel-message send *and* receive on the ThinkNode M9
 * standalone custom firmware (`ThinkNode_M9_custom_`, `examples/m9_custom`).
 *
 * Sibling of `m9-live.test.ts` (which only proves the repeater dispatches an
 * injected frame). Here the guest is the LVGL standalone app, which now:
 *   - registers MeshCore's built-in "Public" group channel at boot, so an
 *     injected GRP_TXT actually decrypts (`StandaloneApp::searchChannelsByHash`
 *     + `registerPublicChannel`), and `onGroupDataRecv` prints
 *     `[MESH] Channel RX: <sender>: <text>`;
 *   - originates a channel broadcast from a `/chan <text>` line on the UART0
 *     console (`LvglKeypadDriver` intercepts `/`-prefixed lines →
 *     `AppUI::handleConsoleCommand` → `StandaloneApp::sendChannelMessage`),
 *     which the LR1110 model decodes back to plaintext in its `tx` event
 *     (`decodeMeshFrame` in `src/shared/devices/lr1110.ts`).
 *
 * Distinct strings each way ("rx probe" injected, "tx probe" sent) so the send
 * assertion cannot be satisfied by the node re-flooding the received frame
 * (`Mesh::onRecvPacket` does not `markDoNotRetransmit()` a GRP_TXT) — that relay
 * TX is a bonus confirmation the receive path decrypted.
 *
 * Gated: PINBENCH_M9_CHANNEL=1 and PINBENCH_M9_IMAGE → a merged 16 MB flash
 * image of `ThinkNode_M9_custom_` (DIO / `dio_opi` override, then
 * `esptool merge_bin --fill-flash-size 16MB`).
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DeviceHost } from './devices'
import { parseBoard } from '../shared/board'

const RUN = process.env['PINBENCH_M9_CHANNEL'] === '1'
const IMAGE = process.env['PINBENCH_M9_IMAGE'] ?? ''
const QEMU = resolve(__dirname, '../../.qemu/build/qemu-system-xtensa')
const BOARD = resolve(__dirname, '../../boards/thinknode-m9-v1.0.board.json')

const BOOT_MAX_MS = Number(process.env['PINBENCH_M9_BOOT_MS'] ?? 150_000)
const STEP_MS = Number(process.env['PINBENCH_M9_STEP_MS'] ?? 12_000)

describe.skipIf(!RUN || !IMAGE || !existsSync(IMAGE) || !existsSync(QEMU))(
  'M9 custom firmware: channel message send + receive',
  () => {
    const host = new DeviceHost()
    let child: ReturnType<typeof spawn> | null = null
    // QEMU writes `if=mtd` back into the drive file (SPIFFS format/identity), so
    // run off a fresh copy — a run killed mid-format otherwise leaves the shared
    // image in a state the next boot hangs recovering.
    const scratchImage = join(tmpdir(), `m9-channel-${process.pid}.bin`)
    let serial = ''
    const u2events: string[] = []
    let sendPhase = false
    const sendPhaseEvents: string[] = []

    beforeAll(
      async () => {
        const board = parseBoard(JSON.parse(readFileSync(BOARD, 'utf8')))
        host.load(board)
        host.on('event', (m: { partId: string; event: { kind: string; summary: string } }) => {
          if (m.partId !== 'u2') return
          const line = `${m.event.kind} ${m.event.summary}`
          u2events.push(line)
          if (sendPhase) sendPhaseEvents.push(line)
        })

        copyFileSync(IMAGE, scratchImage)
        const sock = join(tmpdir(), `m9-channel-${process.pid}.sock`)
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
            `file=${scratchImage},if=mtd,format=raw`,
            '-serial',
            'mon:stdio',
            '-no-reboot'
          ],
          { env: { ...process.env, PINBENCH_DEVICE_SOCKET: sock }, stdio: ['pipe', 'pipe', 'pipe'] }
        )
        child.stdout?.on('data', (d: Buffer) => (serial += d.toString()))
        child.stderr?.on('data', (d: Buffer) => (serial += d.toString()))

        const t0 = Date.now()
        while (Date.now() - t0 < BOOT_MAX_MS && !serial.includes('M9 Custom Firmware Ready')) {
          await new Promise((r) => setTimeout(r, 1000))
        }
        if (!serial.includes('M9 Custom Firmware Ready')) throw new Error('firmware did not boot')
        await new Promise((r) => setTimeout(r, 3000))

        // 1. Receive: inject a Public-channel GRP_TXT from the LR1110 IN panel.
        host.command('u2', 'inject', { kind: 'channel', text: 'rx probe', rssi: -72, snr: 9 })
        await new Promise((r) => setTimeout(r, STEP_MS))

        // 2. Send: a '/chan' console line the firmware turns into a real broadcast.
        sendPhase = true
        child.stdin?.write(Buffer.from('/chan tx probe\n'))
        await new Promise((r) => setTimeout(r, STEP_MS))
      },
      BOOT_MAX_MS + STEP_MS * 2 + 30_000
    )

    afterAll(async () => {
      child?.kill('SIGKILL')
      await host.dispose()
      try {
        rmSync(scratchImage)
      } catch {
        // best effort
      }
      console.log('u2 events:\n' + u2events.join('\n'))
    })

    it('boots the standalone firmware and registers the Public channel', () => {
      expect(serial).not.toMatch(/Radio Init Failed/i)
      expect(serial).toMatch(/Channel registered: 'Public'/)
      expect(serial).toMatch(/M9 Custom Firmware Ready/)
    })

    it('decrypts the injected channel message and logs the text', () => {
      expect(u2events.some((e) => /rx RX channel "pinbench: rx probe"/.test(e))).toBe(true)
      expect(serial).toMatch(/Channel RX: pinbench: rx probe/)
    })

    it('broadcasts a channel message from the /chan console command', () => {
      expect(serial).toMatch(/\[CONSOLE\] \/chan -> sent/)
      expect(serial).toMatch(/Channel message sent: 'tx probe'/)
      // The LR1110 model decodes the transmitted frame back to plaintext.
      expect(sendPhaseEvents.some((e) => /tx TX channel "ThinkNode M9: tx probe"/.test(e))).toBe(
        true
      )
    })
  }
)
