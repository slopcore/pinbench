// @vitest-environment node
/**
 * Live end-to-end: boot the Waveshare ESP32-S3-ETH kit fixture
 * (`test/firmware/s3-eth-kit`) on the PinBench-patched
 * `qemu-system-xtensa -machine esp32s3` with the real `DeviceHost` and the
 * kit's board profile, and assert both modelled peripherals work through the
 * real guest drivers:
 *
 *   - the round GC9A01 module, on its own SPI bus with a GPIO chip-select,
 *     receives the painted stripes;
 *   - the Elatec TWN4 on UART1 — QEMU's second `-serial`, bridged to the host
 *     by `DeviceHost.listenUart` — answers Simple Protocol, and a card
 *     presented from the IN panel comes back out of the firmware's SearchTag;
 *   - the W5500, driven by the stock Arduino Ethernet library, gets a DHCP
 *     lease, fetches a page from an HTTP server this test runs on localhost
 *     (the guest's gateway 10.0.2.2), and serves a TCP echo the test connects
 *     to from the host.
 *
 * Skipped unless `PINBENCH_LIVE_QEMU=1` and `PINBENCH_S3_ETH_IMAGE` points at a
 * merged 16 MB flash image of the fixture (see its platformio.ini).
 */
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DeviceHost } from './devices'
import { parseBoard } from '../shared/board'
import { uart1Args } from '../shared/emulator'
import { TWN4_VERSION } from '../shared/devices/twn4'

const LIVE = process.env['PINBENCH_LIVE_QEMU'] === '1'
const IMAGE = process.env['PINBENCH_S3_ETH_IMAGE'] ?? ''
const QEMU = resolve(__dirname, '../../.qemu/build/qemu-system-xtensa')
const BOARD = resolve(__dirname, '../../boards/waveshare-esp32-s3-eth-gc9a01-twn4.board.json')

const RED = 0xf800
const GREEN = 0x07e0
const BLUE = 0x001f

interface Frame {
  partId: string
  width: number
  height: number
  displayOn: boolean
  backlightOn: boolean
  pixels: ArrayBuffer | Uint16Array
}

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline && !check()) await new Promise((r) => setTimeout(r, 100))
}

describe.skipIf(!LIVE || !IMAGE || !existsSync(IMAGE) || !existsSync(QEMU))(
  'Waveshare ESP32-S3-ETH kit live: GC9A01 frame + TWN4 over UART1',
  () => {
    const host = new DeviceHost()
    const diagnostics: string[] = []
    let serial = ''
    let child: ReturnType<typeof spawn> | null = null
    let frame: Frame | null = null
    let http: Server | null = null
    let httpPath = ''
    let echoReply = ''
    const runImage = join(tmpdir(), `s3-eth-live-${process.pid}.bin`)

    beforeAll(async () => {
      copyFileSync(IMAGE, runImage)
      http = createServer((req, res) => {
        httpPath = req.url ?? ''
        res.end('hello from the host')
      })
      await new Promise<void>((r) => http!.listen(18080, '127.0.0.1', () => r()))
      host.load(parseBoard(JSON.parse(readFileSync(BOARD, 'utf8'))))
      host.on('framebuffer', (m: Frame) => {
        if (m.partId === 'u3') frame = m
      })
      host.on('diagnostic', (d: { severity: string; message: string }) =>
        diagnostics.push(`${d.severity} ${d.message}`)
      )

      const sock = join(tmpdir(), `s3-eth-live-${process.pid}.sock`)
      const uartSock = join(tmpdir(), `s3-eth-live-${process.pid}-uart1.sock`)
      await host.listen(sock)
      await host.listenUart(1, uartSock)
      child = spawn(
        QEMU,
        [
          '-nographic',
          '-machine',
          'esp32s3',
          '-drive',
          `file=${runImage},if=mtd,format=raw`,
          '-serial',
          'mon:stdio',
          '-no-reboot',
          ...uart1Args(uartSock)
        ],
        { env: { ...process.env, PINBENCH_DEVICE_SOCKET: sock }, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      child.stdout?.on('data', (d: Buffer) => (serial += d.toString()))
      child.stderr?.on('data', (d: Buffer) => (serial += d.toString()))

      await waitFor(() => serial.includes('PINBENCH-S3: eth echo server up'), 60_000)
      // Let the host's frame timer sample the finished GRAM.
      await new Promise((r) => setTimeout(r, 500))

      host.command('u4', 'present', { uid: '04A1B2C3', type: 'mifare' })
      await waitFor(() => serial.includes('PINBENCH-S3: tag type'), 5_000)
      host.command('u4', 'remove')
      await waitFor(() => serial.includes('PINBENCH-S3: tag gone'), 5_000)

      echoReply = await new Promise<string>((resolveReply) => {
        const client = connect(18081, '127.0.0.1', () => client.write('kit\n'))
        let text = ''
        client.on('data', (d) => (text += d.toString()))
        client.on('close', () => resolveReply(text))
        client.on('error', () => resolveReply(`error: ${text}`))
        setTimeout(() => client.destroy(), 5_000)
      })
      // The firmware logs the echo after it has closed the socket.
      await waitFor(() => serial.includes('PINBENCH-S3: echo '), 3_000)
    }, 90_000)

    afterAll(async () => {
      child?.kill('SIGKILL')
      http?.close()
      await host.dispose()
      rmSync(runImage, { force: true })
    })

    it('the GC9A01 frame carries the painted stripes, lit', () => {
      expect(serial).toContain('PINBENCH-S3: lcd frame done')
      expect(frame).not.toBeNull()
      const f = frame!
      expect([f.width, f.height, f.displayOn, f.backlightOn]).toEqual([240, 240, true, true])
      const px =
        f.pixels instanceof Uint16Array ? f.pixels : new Uint16Array(f.pixels as ArrayBuffer)
      const at = (x: number, y: number): number => px[y * 240 + x]!
      expect(at(120, 10)).toBe(RED)
      expect(at(120, 120)).toBe(GREEN)
      expect(at(120, 230)).toBe(BLUE)
    })

    it('the TWN4 answers GetVersionString and GPIOSetBits over UART1', () => {
      const hex = Array.from(TWN4_VERSION, (c) =>
        c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')
      ).join('')
      const len = TWN4_VERSION.length.toString(16).toUpperCase().padStart(2, '0')
      expect(serial).toContain(`PINBENCH-S3: twn4 version 00${len}${hex}`)
      expect(serial).toContain('PINBENCH-S3: twn4 led 00')
      expect(host.snapshots().find((s) => s.partId === 'u4')?.state).toMatchObject({
        leds: { green: true }
      })
    })

    it('a presented card comes back out of SearchTag, and its removal too', () => {
      expect(serial).toContain('PINBENCH-S3: tag type 80 uid 04A1B2C3')
      expect(serial).toContain('PINBENCH-S3: tag gone (0000)')
    })

    it('the W5500 is detected, linked and leased 10.0.2.15 by DHCP', () => {
      // hardwareStatus 3 = EthernetW5500, linkStatus 1 = LinkON.
      expect(serial).toContain(
        'PINBENCH-S3: eth hw 3 link 1 dhcp 1 ip 10.0.2.15 gw 10.0.2.2 dns 10.0.2.3'
      )
    })

    it('a TCP client on the W5500 fetches a page from the host', () => {
      expect(httpPath).toBe('/kit')
      expect(serial).toContain(
        "PINBENCH-S3: http status 'HTTP/1.1 200 OK' body 'hello from the host'"
      )
    })

    it('a W5500 server socket is reachable from the host', () => {
      expect(echoReply).toBe('pong:kit\n')
      expect(serial).toContain("PINBENCH-S3: echo 'kit'")
    })

    it('no device model complained', () => {
      expect(diagnostics.filter((d) => /^(error|warn)/.test(d))).toEqual([])
    })
  }
)
