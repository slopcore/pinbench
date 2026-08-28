import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BoardDefinition } from '../shared/board'
import { DeviceRegistry } from '../shared/devices/registry'
import { ledDescriptor } from '../shared/devices/led'
import { encodeFrame, FrameDecoder, Op, signalHash, type Frame } from '../shared/devices/protocol'
import { DeviceHost, type DeviceEventMessage, type DeviceSnapshotMessage } from './devices'
import type { Diagnostic } from '../shared/diagnostics'

function board(over: Partial<BoardDefinition> = {}): BoardDefinition {
  return {
    schema: 1,
    id: 'test',
    name: 'Test board',
    mcu: 'ESP32-S3',
    vendor: 'PinBench',
    pins: [],
    buses: [{ id: 'spi0', kind: 'spi', label: 'SPI0', signals: {} }],
    parts: [
      {
        id: 'd1',
        designator: 'D1',
        name: 'Status LED',
        category: 'interface',
        deviceModel: 'pinbench.led',
        summary: 'demo',
        buses: [],
        pins: [{ signal: 'ANODE', pin: 'GPIO45' }],
        config: [],
        layout: { x: 0, y: 0, width: 10, height: 10 }
      }
    ],
    nets: [],
    emulator: {},
    canvas: { width: 100, height: 100 },
    ...over
  }
}

function registryWithLed(): DeviceRegistry {
  const registry = new DeviceRegistry()
  registry.register(ledDescriptor)
  return registry
}

let host: DeviceHost | null = null
afterEach(async () => {
  await host?.dispose()
  host = null
})

describe('DeviceHost — model lifecycle', () => {
  it('instantiates a model for a part that names one', () => {
    host = new DeviceHost({ registry: registryWithLed() })
    host.load(board())
    expect(host.activeModelIds()).toEqual(['pinbench.led'])
  })

  it('reports an unresolved model id once and leaves the part inert', () => {
    const diags: Diagnostic[] = []
    host = new DeviceHost({ registry: registryWithLed() })
    host.on('diagnostic', (d: Diagnostic) => diags.push(d))
    host.load(
      board({
        parts: [
          {
            id: 'u2',
            designator: 'U2',
            name: 'LR1110',
            category: 'radio',
            deviceModel: 'semtech.lr1110',
            summary: '',
            buses: ['spi0'],
            pins: [],
            config: [],
            layout: { x: 0, y: 0, width: 1, height: 1 }
          }
        ]
      })
    )
    expect(host.activeModelIds()).toEqual([])
    expect(diags).toHaveLength(1)
    expect(diags[0]).toMatchObject({
      severity: 'info',
      message: expect.stringContaining('semtech.lr1110')
    })
  })

  it('makes a repeat load of the same board a no-op (strict-mode remounts)', () => {
    const diags: Diagnostic[] = []
    host = new DeviceHost({ registry: registryWithLed() })
    host.on('diagnostic', (d: Diagnostic) => diags.push(d))
    const b = board({
      parts: [
        {
          id: 'u2',
          designator: 'U2',
          name: 'LR1110',
          category: 'radio',
          deviceModel: 'semtech.lr1110',
          summary: '',
          buses: ['spi0'],
          pins: [],
          config: [],
          layout: { x: 0, y: 0, width: 1, height: 1 }
        }
      ]
    })
    host.load(b)
    host.load(structuredClone(b))
    host.load(structuredClone(b))
    // The "no model" diagnostic is raised once, not once per load.
    expect(diags.filter((d) => d.message.includes('semtech.lr1110'))).toHaveLength(1)
  })

  it('pushes a snapshot with resolved meter values', () => {
    const snaps: DeviceSnapshotMessage[] = []
    host = new DeviceHost({ registry: registryWithLed() })
    host.on('snapshot', (s: DeviceSnapshotMessage) => snaps.push(s))
    host.load(board())
    expect(snaps.at(-1)).toMatchObject({
      partId: 'd1',
      deviceModel: 'pinbench.led',
      state: { lit: false },
      meters: [
        { id: 'duty', label: 'Duty cycle', unit: '%', value: 0 },
        { id: 'edges', value: 0 }
      ]
    })
  })
})

describe('DeviceHost — injection', () => {
  it('drives a signal edge into the model and emits the blink', () => {
    const events: DeviceEventMessage[] = []
    const snaps: DeviceSnapshotMessage[] = []
    host = new DeviceHost({ registry: registryWithLed() })
    host.on('event', (e: DeviceEventMessage) => events.push(e))
    host.on('snapshot', (s: DeviceSnapshotMessage) => snaps.push(s))
    host.load(board())

    host.injectSignal('d1', 'ANODE', 1)
    host.injectSignal('d1', 'ANODE', 0)

    expect(events.map((e) => e.event.summary)).toEqual(['LED on', 'LED off'])
    expect(snaps.at(-1)!.state).toMatchObject({ lit: false, edges: 2 })
  })

  it('only emits a snapshot when the state actually changes', () => {
    const snaps: DeviceSnapshotMessage[] = []
    host = new DeviceHost({ registry: registryWithLed() })
    host.load(board())
    host.on('snapshot', (s: DeviceSnapshotMessage) => snaps.push(s))
    host.injectSignal('d1', 'ANODE', 0) // no change from power-on low
    expect(snaps).toHaveLength(0)
  })
})

describe('DeviceHost — failure policy', () => {
  it('quarantines a model that throws and answers 0xFF, not zeros', () => {
    const diags: Diagnostic[] = []
    const registry = new DeviceRegistry()
    registry.register({
      id: 'test.throws',
      summary: '',
      create: () => ({
        id: 'test.throws',
        meters: [],
        attach: () => undefined,
        reset: () => undefined,
        detach: () => undefined,
        onBus: () => {
          throw new Error('kaboom')
        },
        snapshot: () => ({}),
        meter: () => undefined
      })
    })
    host = new DeviceHost({ registry })
    host.on('diagnostic', (d: Diagnostic) => diags.push(d))
    host.load(
      board({
        parts: [
          {
            id: 'x1',
            designator: 'X1',
            name: 'Bad',
            category: 'interface',
            deviceModel: 'test.throws',
            summary: '',
            buses: ['spi0'],
            pins: [],
            config: [],
            layout: { x: 0, y: 0, width: 1, height: 1 }
          }
        ]
      })
    )

    const miso = host.injectBus('x1', new Uint8Array([1, 2, 3]))
    expect([...miso]).toEqual([0xff, 0xff, 0xff])
    expect(diags.some((d) => d.severity === 'error' && /quarantined/.test(d.message))).toBe(true)

    // Still quarantined on the next call — no second throw, just 0xFF.
    expect([...host.injectBus('x1', new Uint8Array([9]))]).toEqual([0xff])
  })
})

describe('DeviceHost — socket transport', () => {
  it('answers a Hello and an Xfer over a real unix socket', async () => {
    const socketPath = join(tmpdir(), `pinbench-dev-${process.pid}-${Date.now()}.sock`)
    host = new DeviceHost({ registry: registryWithLed() })
    host.load(
      board({
        parts: [
          {
            id: 'm1',
            designator: 'M1',
            name: 'Mem',
            category: 'storage',
            deviceModel: 'pinbench.led',
            summary: '',
            buses: ['spi0'],
            pins: [{ signal: 'ANODE', pin: 'GPIO45' }],
            config: [],
            layout: { x: 0, y: 0, width: 1, height: 1 }
          }
        ]
      })
    )
    await host.listen(socketPath)

    const replies = await roundTrip(socketPath, [
      {
        op: Op.Hello,
        reply: false,
        bus: 0xff,
        select: 0xffff,
        seq: 1,
        t: 0,
        payload: ascii('pb1')
      },
      {
        op: Op.Signal,
        reply: false,
        bus: 0,
        select: signalHash('ANODE'),
        seq: 2,
        t: 5,
        payload: new Uint8Array([1])
      },
      {
        op: Op.Xfer,
        reply: false,
        bus: 0,
        select: signalHash('ANODE'),
        seq: 3,
        t: 6,
        payload: new Uint8Array([0, 0, 0, 0])
      }
    ])

    // Hello echoes; Signal takes no reply; Xfer replies (LED has no onBus → 0xFF).
    expect(replies).toHaveLength(2)
    expect(replies[0]).toMatchObject({ op: Op.Hello, reply: true })
    expect(new TextDecoder().decode(replies[0]!.payload)).toBe('pb1')
    expect(replies[1]).toMatchObject({ op: Op.Xfer, reply: true, seq: 3 })
    expect([...replies[1]!.payload]).toEqual([0xff, 0xff, 0xff, 0xff])
  })
})

function ascii(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function roundTrip(socketPath: string, frames: Frame[]): Promise<Frame[]> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    const decoder = new FrameDecoder()
    const got: Frame[] = []
    socket.on('connect', () => {
      for (const frame of frames) socket.write(encodeFrame(frame))
    })
    socket.on('data', (chunk: Buffer) => {
      got.push(...decoder.push(new Uint8Array(chunk)))
    })
    socket.on('error', reject)
    // The transport is synchronous per frame; a short settle is enough.
    setTimeout(() => {
      socket.end()
      resolve(got)
    }, 100)
  })
}
