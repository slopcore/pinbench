import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BoardDefinition } from '../shared/board'
import { DeviceRegistry } from '../shared/devices/registry'
import { ledDescriptor } from '../shared/devices/led'
import { lr1110Descriptor } from '../shared/devices/lr1110'
import { encodeFrame, FrameDecoder, Op, signalHash, type Frame } from '../shared/devices/protocol'
import { st7789Descriptor } from '../shared/devices/st7789'
import {
  DeviceHost,
  type DeviceEventMessage,
  type DeviceFramebufferMessage,
  type DeviceSnapshotMessage
} from './devices'
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

    // Hello replies with the 8-byte input-pin mask; Signal takes no reply;
    // Xfer replies (LED has no onBus → 0xFF). The LED drives nothing into the
    // SoC, so the mask is empty.
    expect(replies).toHaveLength(2)
    expect(replies[0]).toMatchObject({ op: Op.Hello, reply: true })
    expect(replies[0]!.payload).toHaveLength(8)
    expect([...replies[0]!.payload]).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(replies[1]).toMatchObject({ op: Op.Xfer, reply: true, seq: 3 })
    expect([...replies[1]!.payload]).toEqual([0xff, 0xff, 0xff, 0xff])
  })
})

describe('DeviceHost — host→guest GPIO input (M7)', () => {
  function radioBoard(): BoardDefinition {
    return board({
      parts: [
        {
          id: 'u2',
          designator: 'U2',
          name: 'LR1110',
          category: 'radio',
          deviceModel: 'semtech.lr1110',
          summary: '',
          buses: ['spi0'],
          pins: [
            { signal: 'NSS', pin: 'GPIO39' },
            { signal: 'BUSY', pin: 'GPIO41' },
            { signal: 'IRQ', pin: 'GPIO42' },
            { signal: 'NRESET', pin: 'GPIO45' }
          ],
          config: [],
          layout: { x: 0, y: 0, width: 10, height: 10 }
        }
      ]
    })
  }

  function radioHost(): DeviceHost {
    const registry = new DeviceRegistry()
    registry.register(lr1110Descriptor)
    const h = new DeviceHost({ registry })
    h.load(radioBoard())
    return h
  }

  const helloFrame = (): Frame => ({
    op: Op.Hello,
    reply: false,
    bus: 0xff,
    select: 0xffff,
    seq: 1,
    t: 0,
    payload: new Uint8Array(0)
  })

  const gpioRead = (pin: number): Frame => ({
    op: Op.GpioRead,
    reply: false,
    bus: 0xff,
    select: pin,
    seq: 2,
    t: 0,
    payload: new Uint8Array(0)
  })

  const decodeReply = (bytes: Uint8Array | null): Frame => {
    expect(bytes).not.toBeNull()
    return new FrameDecoder().push(bytes!)[0]!
  }

  it('the Hello reply masks exactly the pins a model drives (BUSY 41, IRQ 42)', () => {
    host = radioHost()
    const reply = decodeReply(host.handleFrame(helloFrame()))
    expect(reply.payload).toHaveLength(8)
    // 41 → byte 5 bit 1, 42 → byte 5 bit 2.
    expect([...reply.payload]).toEqual([0, 0, 0, 0, 0, 0x06, 0, 0])
  })

  it('answers GPIO_IN for BUSY (idle low) and reflects a driven IRQ', () => {
    host = radioHost()
    expect(decodeReply(host.handleFrame(gpioRead(41))).payload[0]).toBe(0) // BUSY low

    // Walk the model to a TX so it raises DIO9/IRQ.
    const w = (op: number, ...p: number[]) =>
      host!.injectBus('u2', Uint8Array.from([op >> 8, op & 0xff, ...p]), { select: 'NSS' })
    w(0x020e, 0x02) // SET_PACKET_TYPE LoRa
    w(0x020f, 9, 0x05, 0x05, 0x00) // SET_MODULATION_PARAMS
    w(0x0113, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0) // SET_DIO_IRQ_PARAMS
    w(0x0109, 1, 2, 3, 4) // WRITE_BUFFER
    w(0x020a, 0, 0, 0) // SET_TX → IRQ high

    expect(decodeReply(host.handleFrame(gpioRead(42))).payload[0]).toBe(1) // DIO9 high

    w(0x0114, 0xff, 0xff, 0xff, 0xff) // CLEAR_IRQ
    expect(decodeReply(host.handleFrame(gpioRead(42))).payload[0]).toBe(0)
  })
})

// --- M6: GPIO-selected SPI routing, contention, framebuffer side channel ----

function displayBoard(): BoardDefinition {
  const spiPart = (
    id: string,
    designator: string,
    csPin: string
  ): BoardDefinition['parts'][number] => ({
    id,
    designator,
    name: 'Panel',
    category: 'display',
    deviceModel: 'sitronix.st7789',
    summary: 'demo',
    buses: ['spi0'],
    pins: [
      { signal: 'CS', pin: csPin },
      { signal: 'DC', pin: 'GPIO15' },
      { signal: 'RST', pin: 'GPIO14' },
      { signal: 'BL', pin: 'GPIO17' }
    ],
    config: [],
    layout: { x: 0, y: 0, width: 10, height: 10 }
  })
  return board({
    parts: [
      { ...board().parts[0]!, buses: [], pins: [{ signal: 'ANODE', pin: 'GPIO2' }] },
      spiPart('lcd', 'U3', 'GPIO16'),
      spiPart('sd', 'U4', 'GPIO48')
    ]
  })
}

function registryWithPanels(): DeviceRegistry {
  const registry = new DeviceRegistry()
  registry.register(ledDescriptor)
  registry.register(st7789Descriptor)
  return registry
}

/** One `Op.Gpio` frame: pin in `select`, level in the payload. */
function gpio(pin: number, level: 0 | 1): Frame {
  return {
    op: Op.Gpio,
    reply: false,
    bus: 0xff,
    select: pin,
    seq: 0,
    t: 1000,
    payload: Uint8Array.of(level)
  }
}

function xfer(bytes: number[]): Frame {
  return {
    op: Op.Xfer,
    reply: false,
    bus: 0,
    select: 0xffff,
    seq: 1,
    t: 2000,
    payload: Uint8Array.from(bytes)
  }
}

describe('DeviceHost — M6 display routing', () => {
  it('routes an SPI transaction to whichever GPIO chip-select is low', () => {
    host = new DeviceHost({ registry: registryWithPanels() })
    host.load(displayBoard())
    const snaps: DeviceSnapshotMessage[] = []
    host.on('snapshot', (m: DeviceSnapshotMessage) => snaps.push(m))

    host.handleFrame(gpio(15, 0)) // DC low
    host.handleFrame(gpio(16, 0)) // LCD CS low
    host.handleFrame(xfer([0x11])) // SLPOUT — should reach the LCD only
    host.handleFrame(gpio(15, 1))

    const lcd = snaps.filter((s) => s.partId === 'lcd').at(-1)
    const sd = snaps.filter((s) => s.partId === 'sd').at(-1)
    expect(lcd?.state['poweredOn']).toBe(true)
    expect(sd?.state['poweredOn']).toBeFalsy()
  })

  it('routes by an NSS-named select as well as CS — either device, never both', () => {
    // The real M9: the LR1110 shares spi0 with the ST7789 but names its select
    // `NSS`, not `CS`. If NSS is not recognised, the radio is always "selected",
    // every ST7789 transaction routes to two devices and is dropped, and M7's
    // radio traffic can never be addressed. Both parts are ST7789 models here
    // only so the routed transaction has observable state on either end.
    const spiPanel = (
      id: string,
      designator: string,
      select: { signal: string; pin: string }
    ): BoardDefinition['parts'][number] => ({
      id,
      designator,
      name: 'Panel',
      category: 'display',
      deviceModel: 'sitronix.st7789',
      summary: 'demo',
      buses: ['spi0'],
      pins: [
        select,
        { signal: 'DC', pin: 'GPIO15' },
        { signal: 'RST', pin: id === 'radio' ? 'GPIO45' : 'GPIO14' },
        { signal: 'BL', pin: 'GPIO17' }
      ],
      config: [],
      layout: { x: 0, y: 0, width: 10, height: 10 }
    })
    const twoOnBus = board({
      parts: [
        { ...board().parts[0]!, buses: [], pins: [{ signal: 'ANODE', pin: 'GPIO2' }] },
        spiPanel('radio', 'U2', { signal: 'NSS', pin: 'GPIO39' }),
        spiPanel('lcd', 'U3', { signal: 'CS', pin: 'GPIO16' })
      ]
    })
    host = new DeviceHost({ registry: registryWithPanels() })
    host.load(twoOnBus)
    const snaps: DeviceSnapshotMessage[] = []
    const diags: Diagnostic[] = []
    host.on('snapshot', (m: DeviceSnapshotMessage) => snaps.push(m))
    host.on('diagnostic', (d: Diagnostic) => diags.push(d))
    const poweredOn = (id: string): unknown =>
      snaps.filter((s) => s.partId === id).at(-1)?.state['poweredOn']

    // CS (GPIO16) low, NSS high → SLPOUT reaches the LCD only.
    host.handleFrame(gpio(15, 0))
    host.handleFrame(gpio(16, 0))
    host.handleFrame(xfer([0x11]))
    expect(poweredOn('lcd')).toBe(true)
    expect(poweredOn('radio')).toBeFalsy()

    // Now NSS (GPIO39) low, CS high → the next transaction reaches the radio.
    host.handleFrame(gpio(16, 1))
    host.handleFrame(gpio(39, 0))
    host.handleFrame(xfer([0x29])) // DISPON — distinct from the LCD's SLPOUT
    expect(snaps.filter((s) => s.partId === 'radio').at(-1)?.state['displayOn']).toBe(true)

    expect(diags.some((d) => d.id.includes('cs-contention'))).toBe(false)
    expect(diags.some((d) => d.id.includes('no-target'))).toBe(false)
  })

  it('raises a named bus-contention diagnostic when two chip-selects are low at once', () => {
    host = new DeviceHost({ registry: registryWithPanels() })
    host.load(displayBoard())
    const diags: Diagnostic[] = []
    host.on('diagnostic', (d: Diagnostic) => diags.push(d))

    host.handleFrame(gpio(16, 0))
    host.handleFrame(gpio(48, 0))

    const clash = diags.find((d) => d.id.includes('cs-contention'))
    expect(clash?.severity).toBe('warn')
    expect(clash?.message).toContain('U3')
    expect(clash?.message).toContain('U4')
  })

  it('emits a framebuffer down its own channel after RAMWR traffic, never in the snapshot', () => {
    host = new DeviceHost({ registry: registryWithPanels() })
    host.load(displayBoard())
    const frames: DeviceFramebufferMessage[] = []
    const snaps: DeviceSnapshotMessage[] = []
    host.on('framebuffer', (m: DeviceFramebufferMessage) => frames.push(m))
    host.on('snapshot', (m: DeviceSnapshotMessage) => snaps.push(m))

    host.handleFrame(gpio(16, 0)) // select the LCD
    host.handleFrame(gpio(15, 0)) // DC low → command
    host.handleFrame(xfer([0x2c])) // RAMWR
    host.handleFrame(gpio(15, 1)) // DC high → pixels
    host.handleFrame(xfer([0xf8, 0x00, 0xf8, 0x00]))

    // The host samples frames on a timer; drive it directly.
    ;(host as unknown as { sampleFrames(): void }).sampleFrames()

    expect(frames.length).toBeGreaterThan(0)
    expect(frames[0]!.partId).toBe('lcd')
    expect(frames[0]!.pixels.byteLength).toBe(240 * 320 * 2)
    for (const s of snaps) expect(s.state).not.toHaveProperty('pixels')
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
