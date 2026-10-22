// @vitest-environment node
/**
 * Live: boot the MeshCore companion_radio_usb Heltec Wireless Paper image, learn
 * the guest's identity key over the UART0 companion protocol, inject a signed
 * `pair` advert so the guest auto-adds our synthetic sender as a contact, then
 * inject a `direct` TXT_MSG from the SX1262 IN-panel code path and dump the
 * e-paper framebuffer to confirm the guest decrypted it and rendered the text.
 *
 * Gated: PINBENCH_DIRECT_SCREEN=1 (+ PINBENCH_HELTEC_IMAGE or the build-cache
 * default).
 */
import { spawn } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DeviceHost } from './devices'
import { probeCompanionIdentity } from './mesh-companion'
import { parseBoard } from '../shared/board'

const RUN = process.env['PINBENCH_DIRECT_SCREEN'] === '1'
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

function png(pixels: Uint8Array, scale = 3): Buffer {
  const w = W * scale
  const h = H * scale
  const raw = Buffer.alloc((w + 1) * h)
  for (let y = 0; y < h; y++) {
    const sy = (y / scale) | 0
    for (let x = 0; x < w; x++) {
      const sx = (x / scale) | 0
      const byte = pixels[sy * BYTES_PER_ROW + (sx >> 3)] ?? 0xff
      raw[y * (w + 1) + 1 + x] = byte & (0x80 >> (sx & 7)) ? 0xff : 0x00
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
  ihdr[9] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

describe.skipIf(!RUN || !existsSync(IMAGE) || !existsSync(QEMU))(
  'companion_radio_usb: injected direct message on the e-paper',
  () => {
    const host = new DeviceHost()
    let child: ReturnType<typeof spawn> | null = null
    let lastFrame: Uint8Array | null = null
    let framesAfterInject = 0
    let injected = false
    let discoveredKey: string | null = null
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

      const sock = join(tmpdir(), `direct-screen-${process.pid}.sock`)
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
        { env: { ...process.env, PINBENCH_DEVICE_SOCKET: sock }, stdio: ['pipe', 'pipe', 'pipe'] }
      )
      child.stdout?.on('data', () => {})
      child.stderr?.on('data', () => {})

      await new Promise((r) => setTimeout(r, 35_000))

      // Discovery: DeviceHost's resolver probes the booted companion
      // (CMD_SEND_SELF_ADVERT → its own advert on the radio). Run it once up
      // front and cache it — same as the app after the first `direct` send —
      // so the timed display-wake below isn't eaten by the probe delay.
      discoveredKey = await probeCompanionIdentity(
        {
          writeSerialBytes: (bytes) => child?.stdin?.write(Buffer.from(bytes)),
          onDeviceEvent: (listener) => {
            host.on('event', listener)
            return () => host.off('event', listener)
          }
        },
        { attempts: 30, attemptGapMs: 2000 }
      )
      let resolverCalls = 0
      host.setMeshDirectKeyResolver(() => {
        resolverCalls++
        return Promise.resolve(discoveredKey)
      })

      // 1. Pair: a signed advert for the synthetic sender → auto-added as a contact.
      host.command('u2', 'inject', { kind: 'pair', sender: 'pinbench', rssi: -70, snr: 8 })
      await new Promise((r) => setTimeout(r, 4_000))

      // 2. Wake the display (see channel-screen.test.ts for why).
      host.command('u5', 'click', { holdMs: 300 })
      await new Promise((r) => setTimeout(r, 3_000))

      const OUT = join(tmpdir(), 'pinbench-direct')
      if (lastFrame) writeFileSync(`${OUT}-before.png`, png(lastFrame))

      // 3. Send the direct message exactly as the IN-panel button does — no
      // explicit guestPub, so DeviceHost fills it from the resolver.
      injected = true
      host.command('u2', 'inject', {
        kind: 'direct',
        text: 'PINBENCH DIRECT HELLO',
        rssi: -68,
        snr: 8
      })
      await new Promise((r) => setTimeout(r, 8_000))
      expect(resolverCalls).toBeGreaterThan(0)
      if (lastFrame) writeFileSync(`${OUT}-after.png`, png(lastFrame))
      console.log(`discoveredKey = ${discoveredKey ?? '(none)'}`)
      console.log(`(frames after inject = ${framesAfterInject}; pngs at ${OUT}-*.png)`)
      console.log('u2 events:\n' + u2events.join('\n'))
    }, 200_000)

    afterAll(async () => {
      child?.kill('SIGKILL')
      await host.dispose()
    })

    it('discovered the guest identity key over the companion protocol', () => {
      // Portable: any well-formed 32-byte hex key means discovery worked. (This
      // build's persisted image happens to be 61594de5…; asserting that exact
      // value would just relocate the DEFAULT_GUEST_PUB jank into the test.)
      expect(discoveredKey).toMatch(/^[0-9a-f]{64}$/)
    })

    it('the SX1262 model received the direct frame', () => {
      expect(u2events.some((e) => /rx RX direct/.test(e))).toBe(true)
    })

    it('the e-paper refreshed after the direct inject', () => {
      expect(framesAfterInject).toBeGreaterThan(0)
    })
  }
)
