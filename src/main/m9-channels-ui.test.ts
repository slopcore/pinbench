// @vitest-environment node
/**
 * Visual walk of the M9 standalone firmware's Channels UI, driven entirely from
 * the emulator's keypad model (`u8` key commands → the same ASCII / nav codes
 * the real coprocessor sends):
 *
 *   CHAT               → channel list  (#Public …, "＋ New channel", "Back")
 *   OK on #Public      → channel transcript + compose field
 *   inject a GRP_TXT   → the received line renders in the transcript
 *   type + OK          → the message is sent and echoed locally
 *   Back, ▾, OK on ＋   → new-channel name editor
 *   type "trail", OK   → channel added and its (empty) transcript opens
 *
 * Screenshots land in `.scratch/m9-channels-ui/` (and $PINBENCH_M9_UI_OUT if
 * set). Gated: PINBENCH_M9_UI=1 + PINBENCH_M9_IMAGE.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { deflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseBoard } from '../shared/board'
import { DeviceHost } from './devices'
import type { St7789Model } from '../shared/devices/st7789'

const RUN = process.env['PINBENCH_M9_UI'] === '1'
const IMAGE = process.env['PINBENCH_M9_IMAGE'] ?? ''
const QEMU = resolve(__dirname, '../../.qemu/build/qemu-system-xtensa')
const BOARD = resolve(__dirname, '../../boards/thinknode-m9-v1.0.board.json')
const OUT = process.env['PINBENCH_M9_UI_OUT'] ?? resolve(__dirname, '../../.scratch/m9-channels-ui')

function rgb565ToPng(gram: Uint16Array, w = 320, h = 240): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1)
    for (let x = 0; x < w; x++) {
      const rgb = gram[x * 240 + y] || 0 // MV layout: physX = display y, physY = display x
      const o = row + 1 + x * 4
      raw[o] = (((rgb >> 11) & 0x1f) * 255) / 31
      raw[o + 1] = (((rgb >> 5) & 0x3f) * 255) / 63
      raw[o + 2] = ((rgb & 0x1f) * 255) / 31
      raw[o + 3] = 0xff
    }
  }
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(body), 0)
    return Buffer.concat([len, body, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from('\x89PNG\r\n\x1a\n', 'binary'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

describe.skipIf(!RUN || !IMAGE || !existsSync(IMAGE) || !existsSync(QEMU))(
  'M9 Channels UI walk',
  () => {
    const host = new DeviceHost()
    let child: ReturnType<typeof spawn> | null = null
    let serial = ''
    let model: St7789Model
    const shots: Record<string, string> = {}
    const gramOf = (): Uint16Array => (model as unknown as { gram: Uint16Array }).gram.slice()
    const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    const key = async (k: string, gap = 450): Promise<void> => {
      host.command('u8', 'key', { key: k })
      await settle(gap)
    }
    // The keypad model delivers one code per press; a new press before the
    // firmware has clocked the previous one out drops it. Space them out.
    const type = async (s: string): Promise<void> => {
      for (const ch of s) await key(ch === ' ' ? 'SPACE' : ch, 350)
    }
    const snap = (name: string): void => {
      const p = join(OUT, `${name}.png`)
      writeFileSync(p, rgb565ToPng(gramOf()))
      shots[name] = p
    }

    beforeAll(async () => {
      mkdirSync(OUT, { recursive: true })
      host.load(parseBoard(JSON.parse(readFileSync(BOARD, 'utf8'))))
      model = (host as unknown as { devices: Map<string, { model: St7789Model }> }).devices.get(
        'u3'
      )!.model

      const sock = join(tmpdir(), `m9-ui-${process.pid}.sock`)
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
      for (let i = 0; i < 150 && !serial.includes('M9 Custom Firmware Ready'); i++)
        await settle(1000)
      if (!serial.includes('M9 Custom Firmware Ready')) throw new Error('firmware did not boot')
      await settle(4000)

      // Shortcut sweep — these navigate via loop()'s deferred `_pendingNav`.
      await key('MSG', 1500)
      await key('MAP', 1500)
      await key('HOME', 1500)

      await key('CHAT', 2500)
      snap('1-channel-list')

      // A message arriving while the list is on screen: onChannelMessage rebuilds
      // the list from the mesh-loop context — must not wedge D-pad focus.
      host.command('u2', 'inject', {
        kind: 'channel',
        text: 'first light on the summit',
        sender: 'scout',
        rssi: -70,
        snr: 8
      })
      await settle(2500)
      await key('DOWN', 1200) // focus must still move after the rebuild
      await key('UP', 1200)
      snap('1b-list-after-rx-while-open')

      // A second incoming message, then open the channel.
      host.command('u2', 'inject', {
        kind: 'channel',
        text: 'weather looks good for the ridge',
        sender: 'basecamp',
        rssi: -71,
        snr: 8
      })
      await settle(2500)
      await key('OK', 2500) // open #Public
      snap('2-channel-view-rx')

      // Compose and send from the device.
      await type('ON MY WAY')
      await key('OK', 2500)
      snap('3-channel-view-after-send')

      // Back to the list, add a new channel by name.
      await key('BACK', 2800)
      snap('4-back-to-list')
      await key('DOWN', 1400) // #Public -> ＋ New channel
      snap('5-new-channel-row-focused')
      await key('OK', 2200) // open the name editor
      await type('trail')
      await settle(1000)
      snap('6-new-channel-editor')
      await key('OK', 3000) // create + open #trail
      snap('7-new-channel-opened')
    }, 260_000)

    afterAll(async () => {
      child?.kill('SIGKILL')
      await host.dispose()
      console.log('screenshots:\n' + Object.values(shots).join('\n'))
      console.log(
        serial
          .split('\n')
          .filter((l) => /\[MESH\]|\[UI\]|Channel/.test(l))
          .join('\n')
      )
    })

    it('rendered every Channels screen without a crash', () => {
      expect(Object.keys(shots)).toEqual([
        '1-channel-list',
        '1b-list-after-rx-while-open',
        '2-channel-view-rx',
        '3-channel-view-after-send',
        '4-back-to-list',
        '5-new-channel-row-focused',
        '6-new-channel-editor',
        '7-new-channel-opened'
      ])
      expect(serial).toMatch(/M9 Custom Firmware Ready/)
      expect(serial).not.toMatch(/Guru Meditation|abort\(\)|assert failed/i)
    })

    it('received the injected channel messages and sent one back', () => {
      expect(serial).toMatch(/Channel RX: scout: first light/)
      expect(serial).toMatch(/Channel RX: basecamp: weather looks good/)
      expect(serial).toMatch(/Channel message sent: 'ON MY WAY'/)
    })

    it('added a channel by name from the editor', () => {
      expect(serial).toMatch(/Channel added: 'trail'/)
    })
  }
)
