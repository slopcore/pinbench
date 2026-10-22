// @vitest-environment node
/**
 * Live end-to-end: Waveshare's own Arduino LVGL demo
 * (`test/firmware/waveshare-c6-lvgl`, vendor files unmodified) on the emulated
 * ESP32-C6 with the real `DeviceHost`. LVGL's widgets demo must draw to the
 * GC9A01 model, and a tap through the CST816S model must change the screen —
 * the vendor's touch driver, its RISING ISR and LVGL's pointer indev all in
 * the loop.
 *
 * Skipped unless `PINBENCH_LIVE_QEMU=1` and `PINBENCH_C6_LVGL_IMAGE` points at a
 * merged 16 MB image of that fixture (Build & flash, or the recipe in
 * `c6-live.test.ts`). Writes `before.png` / `after.png` to
 * `PINBENCH_C6_LVGL_OUT` (default `.scratch/c6-lvgl`).
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { deflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DeviceHost } from './devices'
import { parseBoard } from '../shared/board'

const LIVE = process.env['PINBENCH_LIVE_QEMU'] === '1'
const IMAGE = process.env['PINBENCH_C6_LVGL_IMAGE'] ?? ''
const QEMU = resolve(__dirname, '../../.qemu/build/qemu-system-riscv32')
const BOARD = resolve(__dirname, '../../boards/waveshare-esp32-c6-touch-lcd-1.28.board.json')
const OUT = process.env['PINBENCH_C6_LVGL_OUT'] ?? resolve(__dirname, '../../.scratch/c6-lvgl')

const W = 240
const H = 240

function rgb565ToPng(gram: Uint16Array): Buffer {
  const raw = Buffer.alloc((W * 3 + 1) * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const rgb = gram[y * W + x] ?? 0
      const o = y * (W * 3 + 1) + 1 + x * 3
      raw[o] = (((rgb >> 11) & 0x1f) * 255) / 31
      raw[o + 1] = (((rgb >> 5) & 0x3f) * 255) / 63
      raw[o + 2] = ((rgb & 0x1f) * 255) / 31
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
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body), 0)
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0)
  ihdr.writeUInt32BE(H, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function distinctColours(gram: Uint16Array): number {
  return new Set(gram).size
}

function changedPixels(a: Uint16Array, b: Uint16Array): number {
  let n = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++
  return n
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!LIVE || !IMAGE || !existsSync(IMAGE) || !existsSync(QEMU))(
  "Waveshare C6 live: the vendor's LVGL demo draws and takes a tap",
  () => {
    const host = new DeviceHost()
    const runImage = join(tmpdir(), `c6-lvgl-live-${process.pid}.bin`)
    let child: ReturnType<typeof spawn> | null = null
    let serial = ''
    let latest: Uint16Array | null = null
    let before: Uint16Array | null = null
    let after: Uint16Array | null = null
    const touchEvents: string[] = []

    beforeAll(async () => {
      copyFileSync(IMAGE, runImage)
      host.load(parseBoard(JSON.parse(readFileSync(BOARD, 'utf8'))))
      host.on('framebuffer', (m: { partId: string; pixels: ArrayBuffer | Uint16Array }) => {
        if (m.partId !== 'u2') return
        latest = m.pixels instanceof Uint16Array ? m.pixels.slice() : new Uint16Array(m.pixels)
      })
      host.on('event', (m: { partId: string; event: { kind: string; summary: string } }) => {
        if (m.partId === 'u3') touchEvents.push(m.event.summary)
      })
      const sock = join(tmpdir(), `c6-lvgl-live-${process.pid}.sock`)
      await host.listen(sock)
      child = spawn(
        QEMU,
        [
          '-nographic',
          '-machine',
          'esp32c6',
          '-drive',
          `file=${runImage},if=mtd,format=raw`,
          '-serial',
          'mon:stdio',
          '-no-reboot'
        ],
        { env: { ...process.env, PINBENCH_DEVICE_SOCKET: sock }, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      child.stdout?.on('data', (d: Buffer) => (serial += d.toString()))
      child.stderr?.on('data', (d: Buffer) => (serial += d.toString()))

      // Wait for the widgets demo to settle: a rich frame that stops changing.
      const deadline = Date.now() + 60_000
      let stableSince = 0
      let prev: Uint16Array | null = null
      while (Date.now() < deadline) {
        await sleep(500)
        const cur = latest as Uint16Array | null
        if (cur && distinctColours(cur) > 20) {
          if (prev && changedPixels(prev, cur) === 0) {
            if (!stableSince) stableSince = Date.now()
            if (Date.now() - stableSince > 2_000) break
          } else stableSince = 0
          prev = cur
        }
      }
      before = latest

      // lv_demo_widgets on a 240×240 panel: the tab bar runs across the top;
      // tap the right-hand tab ("Analytics") to switch pages.
      host.command('u3', 'tap', { x: 200, y: 20 })
      await sleep(4_000)
      after = latest

      mkdirSync(OUT, { recursive: true })
      if (before) writeFileSync(join(OUT, 'before.png'), rgb565ToPng(before))
      if (after) writeFileSync(join(OUT, 'after.png'), rgb565ToPng(after))
    }, 90_000)

    afterAll(async () => {
      child?.kill('SIGKILL')
      await host.dispose()
      rmSync(runImage, { force: true })
    })

    it('boots without a panic or an LVGL allocation failure', () => {
      expect(serial).not.toMatch(/Guru Meditation|abort\(\)|assert failed/)
      expect(serial).not.toContain('LVGL draw buffer allocation failed')
    })

    it('the widgets demo is on the panel', () => {
      expect(before).not.toBeNull()
      expect(distinctColours(before!)).toBeGreaterThan(20)
    })

    it('a tap through the CST816S changes what LVGL draws', () => {
      expect(touchEvents.some((e) => e.startsWith('Touch at (200, 20)'))).toBe(true)
      expect(after).not.toBeNull()
      expect(changedPixels(before!, after!)).toBeGreaterThan(500)
    })
  }
)
