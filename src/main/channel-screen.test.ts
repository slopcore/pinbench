// @vitest-environment node
/**
 * Live: boot the MeshCore companion_radio_usb Heltec Wireless Paper image, wake
 * the display with a button click, inject a Public-channel GRP_TXT frame from
 * the SX1262 IN-panel code path, and dump the e-paper framebuffer before/after
 * as ASCII so we can see whether the guest decrypted the message and rendered
 * it (MsgPreviewScreen).
 *
 * Gated: PINBENCH_CHAN_SCREEN=1 and PINBENCH_HELTEC_IMAGE (8MB merged bin).
 */
import { spawn } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DeviceHost } from './devices'
import { parseBoard } from '../shared/board'

const RUN = process.env['PINBENCH_CHAN_SCREEN'] === '1'
const IMAGE =
  process.env['PINBENCH_HELTEC_IMAGE'] ??
  join(
    homedir(),
    'Library',
    'Application Support',
    'PinBench',
    'build-cache',
    'MeshCore-Heltec_Wireless_Paper_companion_radio_usb.bin'
  )
const QEMU = resolve(__dirname, '../../.qemu/build/qemu-system-xtensa')
const BOARD = resolve(__dirname, '../../boards/heltec-wireless-paper-v1.1.board.json')

const W = 128
const H = 250
const BYTES_PER_ROW = W / 8

/** Packed 1bpp (bit set = white) → ASCII, column/row subsampled to fit a terminal. */
function ascii(pixels: Uint8Array, xStep = 2, yStep = 4): string {
  const lines: string[] = []
  for (let y = 0; y < H; y += yStep) {
    let line = ''
    for (let x = 0; x < W; x += xStep) {
      const byte = pixels[y * BYTES_PER_ROW + (x >> 3)] ?? 0xff
      const white = (byte & (0x80 >> (x & 7))) !== 0
      line += white ? ' ' : '#'
    }
    lines.push(line)
  }
  return lines.join('\n')
}

/** Packed 1bpp → greyscale PNG, integer-scaled. bit set = white. */
function png(pixels: Uint8Array, scale = 3): Buffer {
  const w = W * scale
  const h = H * scale
  const raw = Buffer.alloc((w + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0 // filter: none
    const sy = (y / scale) | 0
    for (let x = 0; x < w; x++) {
      const sx = (x / scale) | 0
      const byte = pixels[sy * BYTES_PER_ROW + (sx >> 3)] ?? 0xff
      const white = (byte & (0x80 >> (sx & 7))) !== 0
      raw[y * (w + 1) + 1 + x] = white ? 0xff : 0x00
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crcBuf = Buffer.alloc(4)
    crcBuf.writeUInt32BE(crc32(body) >>> 0, 0)
    return Buffer.concat([len, body, crcBuf])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // colour type: greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function inkCount(pixels: Uint8Array): number {
  let n = 0
  for (let i = 0; i < pixels.length; i++) {
    let b = ~pixels[i]! & 0xff
    while (b) {
      n += b & 1
      b >>= 1
    }
  }
  return n
}

describe.skipIf(!RUN || !existsSync(IMAGE) || !existsSync(QEMU))(
  'companion_radio_usb: injected Public-channel message on the e-paper',
  () => {
    const host = new DeviceHost()
    let child: ReturnType<typeof spawn> | null = null
    let serial = ''
    let lastFrame: Uint8Array | null = null
    let framesAfterInject = 0
    let injected = false
    const u2events: string[] = []

    beforeAll(async () => {
      const board = parseBoard(JSON.parse(readFileSync(BOARD, 'utf8')))
      host.load(board)
      host.on('event', (m: { partId: string; event: { kind: string; summary: string } }) => {
        if (m.partId === 'u2') u2events.push(`${m.event.kind} ${m.event.summary}`)
      })
      host.on('framebuffer', (m: { partId: string; pixels: ArrayBuffer }) => {
        if (m.partId !== 'u3') return
        lastFrame = new Uint8Array(m.pixels).slice()
        if (injected) framesAfterInject++
      })

      const sock = join(tmpdir(), `chan-screen-${process.pid}.sock`)
      await host.listen(sock)
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

      await new Promise((r) => setTimeout(r, 18_000))

      // Wake the display so `_display->isOn()` is true when the message lands —
      // on the _usb variant `hasConnection()` is hard-coded true, so `newMsg`
      // never turns the panel on by itself. Click twice with a gap to ride out
      // button-debounce / GPIO-poll latency.
      host.command('u5', 'click', { holdMs: 300 })
      await new Promise((r) => setTimeout(r, 2_000))
      host.command('u5', 'click', { holdMs: 300 })
      await new Promise((r) => setTimeout(r, 2_000))

      const OUT = join(tmpdir(), 'pinbench-chan')
      const before = lastFrame ? ascii(lastFrame) : '(no frame)'
      console.log(`\n===== BEFORE (ink=${lastFrame ? inkCount(lastFrame) : 0}) =====\n${before}`)
      if (lastFrame) writeFileSync(`${OUT}-before.png`, png(lastFrame))

      injected = true
      host.command('u2', 'inject', {
        kind: 'channel',
        text: 'PINBENCH CHANNEL HELLO',
        rssi: -72,
        snr: 9
      })
      // Poll: keep the display awake and wait for the msg-preview refresh.
      for (let k = 0; k < 12 && framesAfterInject === 0; k++) {
        await new Promise((r) => setTimeout(r, 1_000))
        if (k === 5) host.command('u5', 'click', { holdMs: 300 })
      }
      await new Promise((r) => setTimeout(r, 2_000))

      const after = lastFrame ? ascii(lastFrame) : '(no frame)'
      console.log(
        `\n===== AFTER (ink=${lastFrame ? inkCount(lastFrame) : 0}, frames after inject=${framesAfterInject}) =====\n${after}`
      )
      if (lastFrame) writeFileSync(`${OUT}-after.png`, png(lastFrame))
      console.log(`\n(frames written to ${OUT}-before.png / -after.png)`)
      console.log('\n===== u2 events =====\n' + u2events.join('\n'))
    }, 60_000)

    afterAll(async () => {
      child?.kill('SIGKILL')
      await host.dispose()
    })

    it('booted', () => {
      expect(serial.length).toBeGreaterThan(0)
    })

    it('the SX1262 model received the channel frame', () => {
      expect(u2events.some((e) => /rx RX channel/.test(e))).toBe(true)
    })

    it('the e-paper refreshed after the inject', () => {
      expect(framesAfterInject).toBeGreaterThan(0)
    })
  }
)
