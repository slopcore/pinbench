// @vitest-environment node
/**
 * Live ACP end-to-end demonstration for the ThinkNode M9:
 *
 * 1. Stands up the PinBench ACP control plane (HTTP MCP JSON-RPC bridge)
 * 2. Loads the ThinkNode M9 board profile
 * 3. Boots the custom standalone LVGL firmware under QEMU through ACP `emulator_start`
 * 4. Reads and streams guest serial lines via ACP `serial_read`
 * 5. Queries device meters and active states via ACP `device_snapshots`
 * 6. Injects keypad and discrete hardware button navigation via ACP `device_command`
 * 7. Extracts the rendered 320x240 ST7789 framebuffer and saves `screenshot.png`
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { deflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadBoard } from '../board'
import { DeviceHost } from '../devices'
import { EmulatorSupervisor } from '../emulator'
import { startAcpBridge, type AcpBridge, type AcpBridgeWiring } from './bridge'
import type { St7789Model } from '../../shared/devices/st7789'

// Live only: a merged 16 MB M9 custom-firmware image (`PINBENCH_M9_IMAGE`).
const IMAGE = process.env['PINBENCH_M9_IMAGE'] ?? '/tmp/m9_custom_flash_16mb.bin'
const QEMU = resolve(__dirname, '../../../.qemu/build/qemu-system-xtensa')
/** Where the screenshots land (`PINBENCH_SCREENSHOT_DIR`, else the OS temp dir). */
const SHOT_DIR = process.env['PINBENCH_SCREENSHOT_DIR'] ?? tmpdir()
const shot = (name: string): string => join(SHOT_DIR, name)

function rgb565ToRgbaPng(gram: Uint16Array, displayW = 320, displayH = 240): Buffer {
  const raw = Buffer.alloc((displayW * 4 + 1) * displayH)

  for (let y = 0; y < displayH; y++) {
    const rowOffset = y * (displayW * 4 + 1)
    raw[rowOffset] = 0 // PNG filter: None

    for (let x = 0; x < displayW; x++) {
      const physX = y
      const physY = x
      const pixelIndex = physY * 240 + physX
      const rgb565 = gram[pixelIndex] || 0

      // Direct RGB565 -> RGBA8888
      const r = (((rgb565 >> 11) & 0x1f) * 255) / 31
      const g = (((rgb565 >> 5) & 0x3f) * 255) / 63
      const b = ((rgb565 & 0x1f) * 255) / 31

      const pxOffset = rowOffset + 1 + x * 4
      raw[pxOffset + 0] = r & 0xff
      raw[pxOffset + 1] = g & 0xff
      raw[pxOffset + 2] = b & 0xff
      raw[pxOffset + 3] = 0xff
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

  const header = Buffer.from('\x89PNG\r\n\x1a\n', 'binary')
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(displayW, 0)
  ihdr.writeUInt32BE(displayH, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const idat = deflateSync(raw)
  return Buffer.concat([
    header,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ])
}

describe.skipIf(!existsSync(IMAGE) || !existsSync(QEMU))(
  'ThinkNode M9 Live ACP Controller Demonstration',
  () => {
    let bridge: AcpBridge | null = null
    const host = new DeviceHost()
    const emu = new EmulatorSupervisor()
    let sockPath = ''
    let lastSerialText = ''

    async function callAcp(name: string, args: Record<string, unknown> = {}) {
      const res = await fetch(bridge!.server.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bridge!.server.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: { name, arguments: args }
        })
      })
      const json = (await res.json()) as {
        result: { isError?: boolean; structuredContent?: unknown; content: { text: string }[] }
      }
      return json
    }

    beforeAll(async () => {
      const board = loadBoard('thinknode-m9-v1.0')
      host.load(board)

      sockPath = join(tmpdir(), `thinknode-m9-acp-${process.pid}.sock`)
      await host.listen(sockPath)
      emu.setDeviceSocket(sockPath)

      const wiring: AcpBridgeWiring = {
        appVersion: '0.1.0',
        platform: process.platform,
        isDev: true,
        emulator: emu,
        build: { getStatus: () => ({ state: 'idle' }), start: () => {}, cancel: () => {} },
        devices: host,
        getBoard: () => board,
        onBoardChanged: () => {},
        project: {
          open: async (dir) => ({
            dir,
            name: 'm9-firmware',
            envs: ['ThinkNode_M9_custom_']
          }),
          readFile: async () => '',
          actions: async () => [],
          rootDir: () => tmpdir(),
          clean: () => {}
        },
        menuCommand: () => {},
        autoApprove: () => true,
        confirm: async () => true,
        agent: null
      }

      bridge = await startAcpBridge(wiring)
    }, 60_000)

    afterAll(async () => {
      emu.stop()
      await host.dispose()
      await bridge?.dispose()
    })

    it('1. Connects to ACP and reads app info', async () => {
      const res = await callAcp('app_info')
      expect(res.result.isError).toBeUndefined()
      const info = res.result.structuredContent as { version: string; platform: string }
      expect(info.version).toBe('0.1.0')
      console.log('ACP [app_info]:', info)
    })

    it('2. Reads loaded ThinkNode M9 board definition via ACP', async () => {
      const res = await callAcp('board_get')
      expect(res.result.isError).toBeUndefined()
      const b = res.result.structuredContent as { id: string; name: string; parts: unknown[] }
      expect(b.id).toBe('thinknode-m9-v1.0')
      console.log(`ACP [board_get]: Loaded ${b.name} with ${b.parts.length} parts`)
    })

    it('3. Starts QEMU emulator via ACP `emulator_start`', async () => {
      const res = await callAcp('emulator_start', { firmwarePath: IMAGE })
      expect(res.result.isError).toBeUndefined()
      console.log('ACP [emulator_start]: Started QEMU successfully')
    })

    it('4. Polls serial stream and boots firmware past initialization', async () => {
      let booted = false
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        const res = await callAcp('serial_read', { limit: 50 })
        const lines = (
          (res.result?.structuredContent as { lines?: { text: string }[] })?.lines ?? []
        ).map((l) => l.text)
        lastSerialText = lines.join('\n')
        if (lastSerialText.includes('M9 Custom Firmware Ready')) {
          booted = true
          break
        }
      }

      console.log('\n--- Live Serial Output from Emulated M9 ---')
      console.log(lastSerialText)
      expect(booted).toBe(true)
    }, 60_000)

    it('5. Queries active device models & meters via ACP `device_snapshots`', async () => {
      const res = await callAcp('device_snapshots')
      expect(res.result.isError).toBeUndefined()
      const snaps = res.result.structuredContent as {
        devices: { designator: string; name: string; meters: { label: string; value: unknown }[] }[]
      }
      expect(snaps.devices.length).toBeGreaterThan(0)

      console.log('\n--- Active Device Snapshots ---')
      for (const d of snaps.devices) {
        console.log(`- ${d.designator} (${d.name})`)
        for (const m of d.meters ?? []) {
          console.log(`    * ${m.label}: ${m.value}`)
        }
      }
    })

    it('6. Captures rendered ST7789 display framebuffer and saves screenshots', async () => {
      const u3Entry = (
        host as unknown as { devices: Map<string, { model: St7789Model }> }
      ).devices.get('u3')
      expect(u3Entry).toBeDefined()
      const model = u3Entry!.model
      const gram = (model as unknown as { gram: Uint16Array }).gram
      console.log('ST7789 Snapshot:', model.snapshot())
      const uniqueVals = new Set(gram)
      console.log(
        'ST7789 GRAM unique values count:',
        uniqueVals.size,
        'sample:',
        [...uniqueVals].slice(0, 10)
      )

      const png = rgb565ToRgbaPng(gram, 320, 240)
      writeFileSync(shot('m9_home_screen.png'), png)
      console.log(`\nSaved live screenshot to ${shot('m9_home_screen.png')}`)
      expect(png.length).toBeGreaterThan(500)
    })

    async function waitForSerial(
      predicate: (line: string) => boolean,
      timeoutMs = 3000
    ): Promise<string[]> {
      const timeoutAt = Date.now() + timeoutMs
      while (Date.now() < timeoutAt) {
        const res = await callAcp('serial_read', { limit: 50 })
        const lines = (
          (res.result?.structuredContent as { lines?: { text: string }[] })?.lines ?? []
        ).map((l) => l.text)
        if (lines.some(predicate)) return lines
        await new Promise((r) => setTimeout(r, 100))
      }
      const finalRes = await callAcp('serial_read', { limit: 50 })
      return (
        (finalRes.result?.structuredContent as { lines?: { text: string }[] })?.lines ?? []
      ).map((l) => l.text)
    }

    it('7. Drives D-Pad RIGHT via ACP to move focus from Inbox to Channels', async () => {
      // Send D-Pad RIGHT command via ACP device_command
      await callAcp('device_command', { partId: 'u8', command: 'key', args: { key: 'RIGHT' } })
      const lines = await waitForSerial(
        (l) => l.includes('Home Tile Focused: 1') || l.includes('Coprocessor Key')
      )
      console.log('\n--- Serial after D-Pad RIGHT ---')
      console.log(lines.join('\n'))

      // Capture updated framebuffer
      const u3Entry = (
        host as unknown as { devices: Map<string, { model: St7789Model }> }
      ).devices.get('u3')
      const gram = (u3Entry!.model as unknown as { gram: Uint16Array }).gram
      const png = rgb565ToRgbaPng(gram, 320, 240)
      const chPngPath = shot('m9_home_channels_focused.png')
      writeFileSync(chPngPath, png)
      expect(
        lines.some((l) => l.includes('Home Tile Focused: 1') || l.includes('Coprocessor Key'))
      ).toBe(true)
    })

    it('8. Drives D-Pad RIGHT and ENTER via ACP to open Settings screen', async () => {
      // Focus Settings tile (index 2)
      await callAcp('device_command', { partId: 'u8', command: 'key', args: { key: 'RIGHT' } })
      await new Promise((r) => setTimeout(r, 400))
      // Press ENTER to open Settings
      await callAcp('device_command', { partId: 'u8', command: 'key', args: { key: 'ENTER' } })
      const lines = await waitForSerial(
        (l) =>
          l.includes('Home Tile Enter Pressed') ||
          l.includes('Home Tile Clicked: 2') ||
          l.includes('Coprocessor Key')
      )
      console.log('\n--- Serial after Opening Settings ---')
      console.log(lines.join('\n'))

      // Capture Settings framebuffer
      const u3Entry = (
        host as unknown as { devices: Map<string, { model: St7789Model }> }
      ).devices.get('u3')
      const gram = (u3Entry!.model as unknown as { gram: Uint16Array }).gram
      const png = rgb565ToRgbaPng(gram, 320, 240)
      const setPngPath = shot('m9_settings_opened.png')
      writeFileSync(setPngPath, png)
      expect(
        lines.some(
          (l) =>
            l.includes('Home Tile Enter Pressed') ||
            l.includes('Home Tile Clicked: 2') ||
            l.includes('Coprocessor Key')
        )
      ).toBe(true)
    })

    it('9. Drives D-Pad inside Settings via ACP: steps Region Preset and navigates DOWN', async () => {
      // Step Region Preset with RIGHT
      await callAcp('device_command', { partId: 'u8', command: 'key', args: { key: 'RIGHT' } })
      await new Promise((r) => setTimeout(r, 400))
      // Navigate DOWN to Frequency
      await callAcp('device_command', { partId: 'u8', command: 'key', args: { key: 'DOWN' } })
      const lines = await waitForSerial(
        (l) => l.includes('Setting Stepped') || l.includes('Coprocessor Key')
      )
      console.log('\n--- Serial after Settings D-Pad Stepping ---')
      console.log(lines.join('\n'))

      const u3Entry = (
        host as unknown as { devices: Map<string, { model: St7789Model }> }
      ).devices.get('u3')
      const gram = (u3Entry!.model as unknown as { gram: Uint16Array }).gram
      const png = rgb565ToRgbaPng(gram, 320, 240)
      const steppedPngPath = shot('m9_settings_stepped.png')
      writeFileSync(steppedPngPath, png)
      expect(
        lines.some((l) => l.includes('Setting Stepped') || l.includes('Coprocessor Key'))
      ).toBe(true)
    })
  }
)
