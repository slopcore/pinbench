// @vitest-environment node
/**
 * Timestamped M9 boot trace — the "one timestamped boot" the roadmap's M9 item
 * called for. Boots the same `ThinkNode_M9_repeater_` image as `m9-live.test.ts`
 * under the real `DeviceHost`, stamps a millisecond offset on every serial byte,
 * and prints a phase table.
 *
 * Result (m9-dev @ cd865bf8, fork esp-develop-9.2.2-20260417): the repeater
 * reaches its main loop in **~6.5 s warm, ~10.5 s on a fresh flash** (the extra
 * ~3.6 s is a one-time `SPIFFS.begin(true)` format of the empty partition — QEMU
 * writes `if=mtd` back to the image file, so only the first boot pays it). There
 * is no 2.5-minute anything and no I2C-scan pathology: the S3 QEMU machine
 * models no I2C peripheral, the 112-address scan just eats ~112 x 50 ms of
 * `Wire` timeout and is invisible against the radio/FS init. The old "~2.5 min"
 * figure was never a measurement — it was `m9-live.test.ts`'s generous
 * `PINBENCH_M9_BOOT_MS` wait constant, assumed necessary.
 *
 * Skipped unless `PINBENCH_LIVE_QEMU=1` and `PINBENCH_M9_IMAGE` points at a
 * merged 16 MB image. The raw stamped log goes to `PINBENCH_M9_TRACE_LOG` if
 * set, else a temp file whose path is printed.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeAll, describe, expect, it } from 'vitest'
import { DeviceHost } from './devices'
import { parseBoard } from '../shared/board'

const LIVE = process.env['PINBENCH_LIVE_QEMU'] === '1'
const IMAGE = process.env['PINBENCH_M9_IMAGE'] ?? ''
const QEMU = resolve(__dirname, '../../.qemu/build/qemu-system-xtensa')
const BOARD = resolve(__dirname, '../../boards/thinknode-m9-v1.0.board.json')

const MAX_MS = Number(process.env['PINBENCH_M9_TRACE_MAX_MS'] ?? 120_000)
const LOG = process.env['PINBENCH_M9_TRACE_LOG'] ?? join(tmpdir(), `m9-trace-${process.pid}.log`)

/** Ordered [label, substring] milestones, matched against the stitched stream. */
const MARKERS: Array<[label: string, needle: string]> = [
  ['app entry', 'entry 0x'],
  ['setup / display init (pin-227 artifact)', '__pinMode'],
  ['SPIFFS mount failed (fresh flash only)', 'SPIFFS: mount failed'],
  ['identity keypair gen', 'Generating new keypair'],
  ['main loop — "Repeater ID:"', 'Repeater ID:'],
  ['GPS detect done', 'GPS detected']
]

describe.skipIf(!LIVE || !IMAGE || !existsSync(IMAGE) || !existsSync(QEMU))('M9 boot trace', () => {
  const host = new DeviceHost()
  let child: ReturnType<typeof spawn> | null = null
  /** Per-byte wall-clock offset, parallel to `serial`. */
  const byteMs: number[] = []
  let serial = ''

  beforeAll(async () => {
    const board = parseBoard(JSON.parse(readFileSync(BOARD, 'utf8')))
    host.load(board)
    const sock = join(tmpdir(), `m9-trace-${process.pid}.sock`)
    await host.listen(sock)

    const t0 = Date.now()
    const stamp = (buf: Buffer): void => {
      const ms = Date.now() - t0
      const text = buf.toString()
      serial += text
      for (let i = 0; i < text.length; i++) byteMs.push(ms)
    }
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
    child.stdout?.on('data', stamp)
    child.stderr?.on('data', stamp)

    const start = Date.now()
    while (Date.now() - start < MAX_MS && !/Repeater ID:/.test(serial)) {
      await new Promise((r) => setTimeout(r, 250))
    }
    await new Promise((r) => setTimeout(r, 1500))
    child.kill('SIGKILL')
    await host.dispose()

    // Stitched, human-readable log: one physical line per serial newline, each
    // prefixed with the offset of its first byte.
    const out: string[] = []
    let lineStart = 0
    serial.split('\n').forEach((line) => {
      const ms = byteMs[lineStart] ?? byteMs[byteMs.length - 1] ?? 0
      out.push(`+${String(ms).padStart(7)}ms  ${line}`)
      lineStart += line.length + 1
    })
    writeFileSync(LOG, out.join('\n') + '\n')
  }, MAX_MS + 30_000)

  it('reaches the repeater main loop', () => {
    expect(serial).not.toMatch(/radio init failed/i)
    expect(serial).toContain('Repeater ID:')
  })

  it('prints a boot phase breakdown', () => {
    const at = (needle: string): number | null => {
      const i = serial.indexOf(needle)
      return i >= 0 ? (byteMs[i] ?? null) : null
    }

    let prev = 0
    const rows = MARKERS.map(([label, needle]) => {
      const ms = at(needle)
      if (ms == null) return `  ${label.padEnd(40)}  —`
      const delta = ms - prev
      prev = ms
      return `  ${label.padEnd(40)}  ${String(ms).padStart(7)}ms   (+${delta}ms)`
    })

    const total = at('Repeater ID:')
    console.log(
      [
        '',
        '── M9 boot phase trace ──────────────────────────────────────',
        ...rows,
        '────────────────────────────────────────────────────────────',
        `  total to main loop:  ${total == null ? 'n/a' : total + 'ms'}`,
        `  raw stamped log:     ${LOG}`,
        '────────────────────────────────────────────────────────────',
        ''
      ].join('\n')
    )

    // Guard the headline finding. Warm boot ~6.5 s, cold (one-time SPIFFS
    // format) ~10.5 s — 20 s leaves headroom over cold while still tripping on
    // any real regression.
    expect(total).not.toBeNull()
    expect(total!).toBeLessThan(20_000)
  })
})
