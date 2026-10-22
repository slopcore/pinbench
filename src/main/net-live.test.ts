// @vitest-environment node
/**
 * Live end-to-end for the emulated network ([[emulated-network]]): boot a real
 * MeshCore Heltec repeater built with `PINBENCH_EMULATED_NET` under the patched
 * QEMU + the real `DeviceHost`, with QEMU's slirp user stack bound to the fork's
 * OpenCores Ethernet MAC, and assert the guest actually talks to the internet.
 *
 * The MeshCore repeater stops emitting plain-text serial once its binary
 * companion protocol takes over UART0 (the existing `heltec-live.test.ts` sees
 * only up to "Repeater ID:" too), so this test's source of truth is a **pcap**
 * of the slirp netdev, not the serial log: it decodes the capture and checks
 * that the guest resolved api.open-meteo.com over DNS (TX + RX both work through
 * the BD ring) and opened a TLS connection to it.
 *
 * The firmware uses slirp's fixed addressing statically (10.0.2.15/24, gw .2,
 * DNS .3) rather than DHCP — Espressif's lwIP port patches `dhcp_start()` to
 * call back into `esp_netif`, which a raw netif has no handle for — so there is
 * no DHCP exchange to assert on.
 *
 * Skipped unless `PINBENCH_NET_LIVE=1` and `PINBENCH_HELTEC_IMAGE` points at a
 * merged flash image built for the emulator WITH the network flag:
 *
 *   PLATFORMIO_BUILD_FLAGS=-DPINBENCH_EMULATED_NET=1 \
 *     pio run -e Heltec_Wireless_Paper_repeater -c <DIO override>
 *   esptool merge_bin --fill-flash-size 8MB -o merged-net.bin \
 *     0x0 bootloader.bin 0x8000 partitions.bin 0xe000 boot_app0.bin \
 *     0x10000 firmware.bin
 *
 * Needs host network egress (slirp NAT to the real internet), so it never runs
 * in the normal suite.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DeviceHost } from './devices'
import { parseBoard } from '../shared/board'

const LIVE = process.env['PINBENCH_NET_LIVE'] === '1'
const IMAGE = process.env['PINBENCH_HELTEC_IMAGE'] ?? ''
const QEMU = resolve(__dirname, '../../.qemu/build/qemu-system-xtensa')
const BOARD = resolve(__dirname, '../../boards/heltec-wireless-paper-v1.1.board.json')

/** Minimal pcap reader: link type is EN10MB. Returns each frame's bytes. */
function readPcapFrames(path: string): Buffer[] {
  const buf = readFileSync(path)
  if (buf.length < 24) return []
  const magic = buf.readUInt32LE(0)
  const le = magic === 0xa1b2c3d4 || magic === 0xa1b23c4d
  const u32 = (o: number): number => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
  const frames: Buffer[] = []
  let o = 24
  while (o + 16 <= buf.length) {
    const caplen = u32(o + 8)
    o += 16
    if (o + caplen > buf.length) break
    frames.push(buf.subarray(o, o + caplen))
    o += caplen
  }
  return frames
}

interface Decoded {
  udpSrcPort: number
  udpDstPort: number
  tcpDstPort: number
  isIPv4: boolean
}

function decode(frame: Buffer): Decoded {
  const d: Decoded = { udpSrcPort: 0, udpDstPort: 0, tcpDstPort: 0, isIPv4: false }
  if (frame.length < 14) return d
  const ethType = frame.readUInt16BE(12)
  if (ethType !== 0x0800) return d
  d.isIPv4 = true
  const ihl = (frame[14]! & 0x0f) * 4
  const proto = frame[23]!
  const l4 = 14 + ihl
  if (proto === 17 && frame.length >= l4 + 8) {
    d.udpSrcPort = frame.readUInt16BE(l4)
    d.udpDstPort = frame.readUInt16BE(l4 + 2)
  } else if (proto === 6 && frame.length >= l4 + 4) {
    d.tcpDstPort = frame.readUInt16BE(l4 + 2)
  }
  return d
}

describe.skipIf(!LIVE || !IMAGE || !existsSync(IMAGE) || !existsSync(QEMU))(
  'Heltec live: the emulated network reaches the internet',
  () => {
    const host = new DeviceHost()
    let serial = ''
    let child: ReturnType<typeof spawn> | null = null
    const pcap = join(tmpdir(), `pinbench-net-live-${process.pid}.pcap`)
    const traceFile = join(tmpdir(), `pinbench-net-live-${process.pid}.trace`)
    let frames: Buffer[] = []
    let trace = ''

    beforeAll(async () => {
      const board = parseBoard(JSON.parse(readFileSync(BOARD, 'utf8')))
      host.load(board)
      const sock = join(tmpdir(), `pinbench-net-live-${process.pid}.sock`)
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
          '-no-reboot',
          // The S3 machine creates the open_eth NIC via `qemu_create_nic_device`,
          // which needs a `-net nic` NICInfo (this fork's match-default path does
          // not pick up a bare `-netdev`). Pair it with a slirp backend and tap
          // that backend for the capture.
          '-netdev',
          'user,id=u0',
          '-net',
          'nic,model=open_eth,netdev=u0',
          '-object',
          `filter-dump,id=f0,netdev=u0,file=${pcap}`,
          // Host-side view of the MAC: register writes prove the guest reached
          // the openeth MMIO; `open_eth_start_xmit` proves lwIP handed it a
          // frame. Splits "guest never touched the NIC" from "NIC never sent".
          '-D',
          traceFile,
          '-d',
          'trace:open_eth_reg_write,trace:open_eth_reg_read,trace:open_eth_start_xmit,trace:open_eth_update_irq,trace:open_eth_receive'
        ],
        { env: { ...process.env, PINBENCH_DEVICE_SOCKET: sock }, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      child.stdout?.on('data', (d: Buffer) => (serial += d.toString()))
      child.stderr?.on('data', (d: Buffer) => (serial += d.toString()))

      // Boot → WeatherClient::begin() brings the netif up → DHCP → first fetch
      // (PINBENCH_EMULATED_NET seeds weather prefs on, 60 s interval).
      await new Promise((r) => setTimeout(r, 60_000))
      child.kill('SIGTERM')
      await new Promise((r) => setTimeout(r, 1000))
      frames = existsSync(pcap) ? readPcapFrames(pcap) : []
      trace = existsSync(traceFile) ? readFileSync(traceFile, 'utf8') : ''
    }, 90_000)

    afterAll(async () => {
      child?.kill('SIGKILL')
      await host.dispose()
      const regW = (trace.match(/open_eth_reg_write/g) ?? []).length
      const xmit = (trace.match(/open_eth_start_xmit/g) ?? []).length
      console.log(
        `\n--- ${frames.length} pcap frames | ${regW} MAC reg writes | ${xmit} xmit ---\n` +
          `trace head:\n${trace.slice(0, 1500)}\n--- serial tail ---\n${serial.slice(-1500)}`
      )
    })

    it('boots the repeater firmware to its main loop', () => {
      expect(serial).toContain('Repeater ID:')
    })

    it('captures traffic on the emulated NIC at all', () => {
      expect(frames.length).toBeGreaterThan(0)
    })

    it('resolves a hostname over DNS (TX + RX both work through the BD ring)', () => {
      const dns = frames.map(decode).filter((d) => d.udpDstPort === 53 || d.udpSrcPort === 53)
      // query (dst 53) proves TX; response (src 53) proves RX came back through
      // the driver and lwIP accepted it.
      expect(dns.some((d) => d.udpDstPort === 53)).toBe(true)
      expect(dns.some((d) => d.udpSrcPort === 53)).toBe(true)
    })

    it('opens a TLS connection toward api.open-meteo.com', () => {
      expect(frames.map(decode).some((d) => d.tcpDstPort === 443)).toBe(true)
    })
  }
)
