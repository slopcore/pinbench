// @vitest-environment node
/**
 * M9 home-screen "graphics glitch when moving left/right" — repro + fix check.
 *
 * Root cause (found by spatial analysis with a per-RAMWR-window probe): the
 * custom LVGL firmware's home tiles and settings rows carry the default theme's
 * key-focus *outline* (3px wide, 3px pad, drawn OUTSIDE the widget). A focused
 * tile's redraw window is therefore ~6px wider than an unfocused one's, and
 * LVGL's partial refresh only invalidates the current state's area — so on
 * focus loss the outline pixels beyond the smaller window are never repainted.
 * A faint 50%-blue fringe is left at every tile edge and accumulates as you
 * navigate. Fixed in the M9 custom firmware's UI code by
 * zeroing the outline width/pad/opa on those widgets; focus is still shown by
 * the bg + border colour change.
 *
 * The check: after one settled press and after a 16-key alternating burst the
 * screen is in the *same* logical state (Channels focused). With the fix, the
 * two GRAMs are pixel-identical. Before it, edge columns of the Inbox tile
 * drift (the accumulating fringe).
 *
 * Skipped unless a prebuilt M9 image and the patched QEMU are present.
 * `PINBENCH_M9_IMAGE` overrides the image path.
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

const IMAGE = process.env['PINBENCH_M9_IMAGE'] ?? '/tmp/m9_custom_flash_16mb.bin'
const QEMU = resolve(__dirname, '../../.qemu/build/qemu-system-xtensa')
const BOARD = resolve(__dirname, '../../boards/thinknode-m9-v1.0.board.json')
const OUT = resolve(__dirname, '../../.scratch/m9-tearing')

function rgb565ToPng(gram: Uint16Array, w = 320, h = 240): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1)
    raw[row] = 0
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

describe.skipIf(!existsSync(IMAGE) || !existsSync(QEMU))(
  'M9 home-screen nav — no accumulating fringe',
  () => {
    const host = new DeviceHost()
    let child: ReturnType<typeof spawn> | null = null
    let serial = ''
    let model: St7789Model
    let driftCols: number[] = []
    const gramOf = (): Uint16Array => (model as unknown as { gram: Uint16Array }).gram.slice()
    const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

    beforeAll(async () => {
      mkdirSync(OUT, { recursive: true })
      host.load(parseBoard(JSON.parse(readFileSync(BOARD, 'utf8'))))
      model = (host as unknown as { devices: Map<string, { model: St7789Model }> }).devices.get(
        'u3'
      )!.model

      const sock = join(tmpdir(), `m9-tear-${process.pid}.sock`)
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

      for (let i = 0; i < 90 && !serial.includes('M9 Custom Firmware Ready'); i++)
        await settle(1000)
      if (!serial.includes('M9 Custom Firmware Ready')) throw new Error('firmware did not boot')
      await settle(6000)
      writeFileSync(join(OUT, 'a-boot.png'), rgb565ToPng(gramOf()))

      // One press, settle: Inbox -> Channels focused.
      host.command('u8', 'key', { key: 'RIGHT' })
      await settle(4000)
      const b = gramOf()
      writeFileSync(join(OUT, 'b-after-1-right.png'), rgb565ToPng(b))

      // 16-key alternating burst, ~120ms apart, then settle. Net focus returns to
      // Channels (from Channels: L->Inbox, R->Channels, ... x16 ends on Channels).
      for (let i = 0; i < 16; i++) {
        host.command('u8', 'key', { key: i % 2 === 0 ? 'LEFT' : 'RIGHT' })
        await settle(120)
      }
      await settle(8000)
      const c = gramOf()
      writeFileSync(join(OUT, 'c-after-burst.png'), rgb565ToPng(c))

      // b and c are the same logical screen. Any column that differs is fringe
      // that accumulated across the burst.
      driftCols = []
      for (let dx = 0; dx < 320; dx++) {
        let d = 0
        for (let dy = 0; dy < 240; dy++) if (b[dx * 240 + dy] !== c[dx * 240 + dy]) d++
        if (d > 0) driftCols.push(dx)
      }

      // Zoom the left third for eyeballing (x0..108, 3x).
      const cropLeft = (g: Uint16Array, tag: string): void => {
        const sub = new Uint16Array(320 * 240)
        for (let dx = 0; dx < 108; dx++)
          for (let dy = 0; dy < 240; dy++) {
            const v = g[dx * 240 + dy]!
            for (let s = 0; s < 3; s++) {
              const ox = dx * 3 + s
              if (ox < 320) sub[ox * 240 + dy] = v
            }
          }
        writeFileSync(join(OUT, `zoom-${tag}.png`), rgb565ToPng(sub))
      }
      cropLeft(b, 'b')
      cropLeft(c, 'c')
    }, 150_000)

    afterAll(async () => {
      child?.kill('SIGKILL')
      await host.dispose()
    })

    it('boots and dumps PNGs to .scratch/m9-tearing', () => {
      expect(serial).toContain('M9 Custom Firmware Ready')
      expect(existsSync(join(OUT, 'c-after-burst.png'))).toBe(true)
    })

    it('a nav burst leaves no accumulated fringe (b == c, same logical screen)', () => {
      console.log(
        driftCols.length
          ? `columns drifting between 1-press and 16-press settled states: [${driftCols.join(',')}]`
          : 'no drift — settled screen identical after 1 press and after a 16-key burst'
      )
      expect(driftCols).toEqual([])
    })
  }
)
