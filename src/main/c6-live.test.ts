// @vitest-environment node
/**
 * Live end-to-end: boot the Waveshare ESP32-C6-Touch-LCD-1.28 LCD fixture
 * (`test/firmware/waveshare-c6-lcd`) on the PinBench-patched
 * `qemu-system-riscv32 -machine esp32c6` with the real `DeviceHost`, and assert
 * the GC9A01 model receives the frame the firmware paints.
 *
 * Skipped unless `PINBENCH_LIVE_QEMU=1` and `PINBENCH_C6_IMAGE` points at a
 * merged 16 MB flash image of that fixture:
 *
 *   cd test/firmware/waveshare-c6-lcd
 *   PLATFORMIO_CORE_DIR=~/.platformio-pioarduino pio run
 *   esptool.py --chip esp32c6 merge_bin -o c6.bin --flash_mode dio \
 *     --flash_size 16MB --fill-flash-size 16MB 0x0 bootloader.bin \
 *     0x8000 partitions.bin 0xe000 boot_app0.bin 0x10000 firmware.bin
 *
 * What it proves: the fixture's panel bring-up is Waveshare's own GC9A01 driver
 * — `esp_lcd` on IDF `spi_master`, so SPI2 with GDMA descriptors, hardware CS
 * and the TRANS_DONE interrupt. A frame with the right stripes means the C6
 * machine, the DMA GP-SPI2 overlay, GPIO forwarding (DC / RST / BL) and the
 * `galaxycore.gc9a01` model all line up.
 *
 * Touch rides along: the fixture brings the CST816S up with Waveshare's own
 * driver before the panel (I2C0 → `Op.I2c` → `hynitron.cst816s`), and a `tap`
 * command must come back out of the firmware's serial — INT edge, GPIO ISR,
 * register read and all.
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DeviceHost } from './devices'
import { parseBoard } from '../shared/board'

const LIVE = process.env['PINBENCH_LIVE_QEMU'] === '1'
const IMAGE = process.env['PINBENCH_C6_IMAGE'] ?? ''
const QEMU = resolve(__dirname, '../../.qemu/build/qemu-system-riscv32')
const BOARD = resolve(__dirname, '../../boards/waveshare-esp32-c6-touch-lcd-1.28.board.json')

const RED = 0xf800
const GREEN = 0x07e0
const BLUE = 0x001f

interface Frame {
  partId: string
  width: number
  height: number
  inverted: boolean
  displayOn: boolean
  backlightOn: boolean
  pixels: ArrayBuffer | Uint16Array
}

describe.skipIf(!LIVE || !IMAGE || !existsSync(IMAGE) || !existsSync(QEMU))(
  'Waveshare C6 live: esp_lcd DMA frame reaches the GC9A01 model',
  () => {
    const host = new DeviceHost()
    const diagnostics: string[] = []
    let serial = ''
    let child: ReturnType<typeof spawn> | null = null
    let frame: Frame | null = null
    // QEMU `if=mtd` writes back to the image; boot a per-run copy.
    const runImage = join(tmpdir(), `c6-live-${process.pid}.bin`)

    beforeAll(async () => {
      copyFileSync(IMAGE, runImage)
      host.load(parseBoard(JSON.parse(readFileSync(BOARD, 'utf8'))))
      host.on('framebuffer', (m: Frame) => {
        if (m.partId === 'u2') frame = m
      })
      host.on('diagnostic', (d: { severity: string; message: string }) =>
        diagnostics.push(`${d.severity} ${d.message}`)
      )

      const sock = join(tmpdir(), `c6-live-${process.pid}.sock`)
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

      const deadline = Date.now() + 40_000
      while (Date.now() < deadline && !serial.includes('PINBENCH-C6: frame done')) {
        await new Promise((r) => setTimeout(r, 250))
      }
      // Let the host's ~30 fps frame timer sample the finished GRAM.
      await new Promise((r) => setTimeout(r, 500))

      // Touch: a tap through the CST816S model's IN-panel command.
      host.command('u3', 'tap', { x: 100, y: 150 })
      const touchDeadline = Date.now() + 5_000
      while (Date.now() < touchDeadline && !/touch 100,150 event 1/.test(serial)) {
        await new Promise((r) => setTimeout(r, 100))
      }
    }, 60_000)

    afterAll(async () => {
      child?.kill('SIGKILL')
      await host.dispose()
      rmSync(runImage, { force: true })
    })

    it('brings the CST816S up over I2C before the panel, as the demo does', () => {
      expect(serial).toContain('PINBENCH-C6: touch chip 0xB5 fw 1')
      expect(serial).not.toMatch(/Failed to read CST816S/)
    })

    it('a tap reaches the firmware through INT and an I2C report read', () => {
      expect(serial).toContain('PINBENCH-C6: touch 100,150 event 0')
      expect(serial).toContain('PINBENCH-C6: touch 100,150 event 1 gesture SINGLE CLICK')
    })

    it('boots through lcd_init() and every DMA colour transfer', () => {
      expect(serial).toContain('PINBENCH-C6: lcd init done')
      expect(serial).toMatch(/PINBENCH-C6: frame done \(10 color transfers\)/)
      expect(serial).not.toContain('tx_color timeout')
    })

    it('the GC9A01 model sees the full init with no unknown opcodes', () => {
      expect(diagnostics.filter((d) => /GC9A01/.test(d))).toEqual([])
    })

    it('the panel frame carries the painted stripes, lit and in true colour', () => {
      expect(frame).not.toBeNull()
      const f = frame!
      expect(f.width).toBe(240)
      expect(f.height).toBe(240)
      expect(f.displayOn).toBe(true)
      expect(f.backlightOn).toBe(true)
      expect(f.inverted).toBe(false) // INVON on normally-black glass
      const px =
        f.pixels instanceof Uint16Array ? f.pixels : new Uint16Array(f.pixels as ArrayBuffer)
      const at = (x: number, y: number): number => px[y * 240 + x]!
      expect(at(120, 10)).toBe(RED)
      expect(at(120, 120)).toBe(GREEN)
      expect(at(120, 230)).toBe(BLUE)
      expect(at(0, 79)).toBe(RED)
      expect(at(239, 80)).toBe(GREEN)
    })
  }
)
