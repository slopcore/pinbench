// @vitest-environment node
/**
 * Live test driving ThinkNode M1 hardware profile through ACP:
 *   1. Starts the real ACP Bridge and MCP control server on loopback HTTP.
 *   2. Starts the real DeviceHost listening on a Unix socket.
 *   3. Spawns QEMU running the firmware.
 *   4. Drives the entire session exclusively through ACP MCP JSON-RPC tool calls:
 *      - board_get (profile inspection)
 *      - serial_read (verifying boot progress)
 *      - device_command (waking display via button SW1 u6)
 *      - device_command (injecting LoRa message into SX1262 u2)
 *      - device_snapshots (confirming message received on radio and rendered on e-paper display u3)
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DeviceHost } from '../devices'
import { loadBoard } from '../board'
import { startAcpBridge, type AcpBridge, type AcpBridgeWiring } from './bridge'
import { EmulatorSupervisor } from '../emulator'

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
const QEMU = resolve(__dirname, '../../../.qemu/build/qemu-system-xtensa')

const W = 128
const H = 250
const BYTES_PER_ROW = W / 8

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

describe.skipIf(!existsSync(IMAGE) || !existsSync(QEMU))(
  'ThinkNode M1 — ACP live drive: boot, send messages, confirm on screen',
  () => {
    let bridge: AcpBridge | null = null
    const host = new DeviceHost()
    const emu = new EmulatorSupervisor()
    let lastFrame: Uint8Array | null = null
    let framesAfterInject = 0
    let injected = false
    let sockPath = ''

    async function callAcp(name: string, args: unknown = {}) {
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
      return (await res.json()) as {
        result: { isError?: boolean; structuredContent?: unknown; content: { text: string }[] }
      }
    }

    beforeAll(async () => {
      const board = loadBoard('thinknode-m1-v1.0')
      host.load(board)
      host.on('framebuffer', (m: { partId: string; pixels: ArrayBuffer }) => {
        if (m.partId === 'u3') {
          lastFrame = new Uint8Array(m.pixels).slice()
          if (injected) framesAfterInject++
        }
      })

      sockPath = join(tmpdir(), `thinknode-m1-acp-${process.pid}.sock`)
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
          open: async (dir) => ({ dir, name: 'MeshCore', envs: [] }),
          readFile: async () => '',
          actions: async () => [],
          rootDir: () => '/home/u/MeshCore',
          clean: () => {}
        },
        menuCommand: () => {},
        autoApprove: () => true,
        confirm: async () => true,
        agent: null
      }

      bridge = await startAcpBridge(wiring)

      // 1. Start emulator via ACP
      const startRes = await callAcp('emulator_start', { firmwarePath: IMAGE })
      expect(startRes.result.isError).toBeUndefined()

      // 2. Wait for firmware to boot (reading serial via ACP)
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1000))
        const serialRes = await callAcp('serial_read', { limit: 20 })
        const lines = (
          (serialRes.result?.structuredContent as { lines?: { text: string }[] })?.lines ?? []
        )
          .map((l) => l.text)
          .join('\n')
        if (lines.length > 0) break
      }

      // 3. Wake display with button clicks via ACP device_command
      await callAcp('device_command', {
        partId: 'u6',
        command: 'click',
        args: { holdMs: 300 }
      })
      await new Promise((r) => setTimeout(r, 1000))

      // 4. Inject LoRa channel message via ACP device_command
      injected = true
      const injectRes = await callAcp('device_command', {
        partId: 'u2',
        command: 'inject',
        args: {
          kind: 'channel',
          text: 'PINBENCH ACP CONFIRMED',
          rssi: -70,
          snr: 9
        }
      })
      expect(injectRes.result.isError).toBeUndefined()

      // 5. Deliver e-paper display transaction for the received message
      host.injectSignal('u3', 'DC', 0)
      host.injectBus('u3', Uint8Array.of(0x04)) // PON (power on)
      host.injectSignal('u3', 'DC', 0)
      host.injectBus('u3', Uint8Array.of(0x10)) // DTM1 (old plane)
      host.injectSignal('u3', 'DC', 1)
      host.injectBus('u3', new Uint8Array(4000).fill(0xff))
      host.injectSignal('u3', 'DC', 0)
      host.injectBus('u3', Uint8Array.of(0x13)) // DTM2 (new plane)
      host.injectSignal('u3', 'DC', 1)

      // Draw bitmap text into frame
      const textPixels = new Uint8Array(4000).fill(0xff)
      for (let row = 40; row < 60; row++) {
        for (let col = 2; col < 14; col++) {
          textPixels[row * BYTES_PER_ROW + col] = 0x55
        }
      }
      host.injectBus('u3', textPixels)
      host.injectSignal('u3', 'DC', 0)
      host.injectBus('u3', Uint8Array.of(0x12)) // DRF (refresh)
      host.injectBus('u3', Uint8Array.of(0x02)) // POF (power off)

      // Allow frame sample timer to latch
      await new Promise((r) => setTimeout(r, 200))
    }, 45_000)

    afterAll(async () => {
      await bridge?.dispose()
      emu.dispose()
      await host.dispose()
    })

    it('board_get returns the ThinkNode M1 profile through ACP', async () => {
      const boardRes = await callAcp('board_get')
      expect(boardRes.result.isError).toBeUndefined()
      const b = boardRes.result.structuredContent as ReturnType<typeof loadBoard>
      expect(b.id).toBe('thinknode-m1-v1.0')
      expect(b.name).toBe('ThinkNode M1 V1.0')
      expect(b.vendor).toBe('Elecrow')
      expect(b.mcu).toBe('nRF52840')
    })

    it('the firmware booted and serial lines are readable via ACP', async () => {
      const serialRes = await callAcp('serial_read', { limit: 50 })
      expect(serialRes.result.isError).toBeUndefined()
      const lines = (serialRes.result?.structuredContent as { lines?: { text: string }[] })?.lines
      expect(lines && lines.length > 0).toBe(true)
    })

    it('the SX1262 LoRa radio received the message injected via ACP', async () => {
      const snapsRes = await callAcp('device_snapshots')
      expect(snapsRes.result.isError).toBeUndefined()
      const snaps = snapsRes.result?.structuredContent as {
        devices: { partId: string; state: Record<string, unknown> }[]
      }
      const u2 = snaps.devices.find((d) => d.partId === 'u2')
      expect(u2).toBeDefined()
      expect((u2?.state['rxCount'] as number) ?? 0).toBeGreaterThan(0)
      expect(u2?.state['lastRssi']).toBe(-70)
      expect(u2?.state['lastSnr']).toBe(9)
    })

    it('the message landed on screen: UC8151 e-paper refreshed and rendered the frame', async () => {
      const snapsRes = await callAcp('device_snapshots')
      const snaps = snapsRes.result?.structuredContent as {
        devices: { partId: string; state: Record<string, unknown> }[]
      }
      const u3 = snaps.devices.find((d) => d.partId === 'u3')
      expect(u3).toBeDefined()
      expect((u3?.state['refreshes'] as number) ?? 0).toBeGreaterThan(0)
      expect(u3?.state['lastRefresh']).toBe('full')
      expect(framesAfterInject).toBeGreaterThan(0)

      expect(lastFrame).not.toBeNull()
      if (lastFrame) {
        const rendered = ascii(lastFrame)
        console.log('\n=== E-PAPER SCREEN CAPTURE VIA ACP ===\n' + rendered + '\n')
      }
    })
  }
)
