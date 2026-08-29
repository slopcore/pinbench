import { describe, expect, it } from 'vitest'
import { harness } from './harness'
import { Lr1110Model, loraToaMs } from './lr1110'

type H = ReturnType<typeof harness>

/** A RadioLib write command: `[opHi, opLo, ...params]` in one NSS group. */
function write(h: H, op: number, ...params: number[]): void {
  h.bus({
    bus: 'spi0',
    kind: 'spi',
    select: 'NSS',
    mosi: Uint8Array.from([op >> 8, op & 0xff, ...params])
  })
}

/**
 * A RadioLib read command: the opcode write, then a bare-NOP transaction of
 * `replyLen + 1` zero bytes whose reply is `[Stat1, ...data]`.
 */
function read(h: H, op: number, args: number[], replyLen: number): Uint8Array {
  write(h, op, ...args)
  return h.bus({
    bus: 'spi0',
    kind: 'spi',
    select: 'NSS',
    mosi: new Uint8Array(replyLen + 1)
  })
}

/** SPIcheckStatus / getIrqStatus: a bare six-byte zero read. */
function poll(h: H): Uint8Array {
  return h.bus({ bus: 'spi0', kind: 'spi', select: 'NSS', mosi: new Uint8Array(6) })
}

/** RadioLib's SPIparseStatus, transcribed — the check every command passes. */
function parseStatus(stat1: number): 'ok' | 'perr' | 'fail' | 'not-found' {
  if ((stat1 & 0b1110) === 0x01 << 1) return 'perr'
  if ((stat1 & 0b1110) === 0x00 << 1) return 'fail'
  if (stat1 === 0x00 || stat1 === 0xff) return 'not-found'
  return 'ok'
}

const OP = {
  SET_STANDBY: 0x011c,
  SET_DIO_IRQ_PARAMS: 0x0113,
  CLEAR_IRQ: 0x0114,
  CALIBRATE: 0x010f,
  GET_VERSION: 0x0101,
  SET_PACKET_TYPE: 0x020e,
  SET_RF_FREQUENCY: 0x020b,
  SET_MODULATION_PARAMS: 0x020f,
  SET_TX_PARAMS: 0x0211,
  WRITE_BUFFER: 0x0109,
  SET_TX: 0x020a,
  SET_RX: 0x0209
}

describe('Lr1110Model', () => {
  it('comes up in standby with the lines released', () => {
    const h = harness(new Lr1110Model())
    const s = h.snapshot()
    expect(s['mode']).toBe('standby')
    expect(s['packetType']).toBe('LoRa')
    expect(h.line('BUSY')).toBe(0)
    expect(h.line('IRQ')).toBe(0)
    expect(h.diagnostics).toEqual([])
  })

  it('answers the GetVersion handshake so RadioLib findChip() succeeds', () => {
    const h = harness(new Lr1110Model())
    const miso = read(h, OP.GET_VERSION, [], 4)
    expect(parseStatus(miso[0]!)).toBe('ok')
    // [Stat1, hw, device, fwMajor, fwMinor] — device 0x01 == LR1110.
    expect(miso[2]).toBe(0x01)
  })

  it('a status poll after any command parses as CMD_OK', () => {
    const h = harness(new Lr1110Model())
    write(h, OP.SET_STANDBY, 0x00)
    expect(parseStatus(poll(h)[0]!)).toBe('ok')
  })

  it('walks the radio_init() opcode sequence into observable state', () => {
    const h = harness(new Lr1110Model())
    // The shape of LR11x0::modSetup + begin(): reset, version, standby,
    // config (fallback/irq/calibrate/packet-type), then the LoRa params.
    read(h, OP.GET_VERSION, [], 4)
    write(h, OP.SET_STANDBY, 0x00)
    write(h, OP.SET_DIO_IRQ_PARAMS, 0, 0, 0, 0, 0, 0, 0, 0)
    write(h, OP.CLEAR_IRQ, 0xff, 0xff, 0xff, 0xff)
    write(h, OP.CALIBRATE, 0x3f)
    write(h, OP.SET_PACKET_TYPE, 0x02) // LoRa
    write(h, OP.SET_MODULATION_PARAMS, 11, 0x05, 0x05, 0x00) // SF11, BW250, CR4/5
    write(h, OP.SET_RF_FREQUENCY, 0x37, 0x59, 0x8a, 0x00) // 0x37598A00 = 928.5 MHz-ish
    write(h, OP.SET_TX_PARAMS, 22 & 0xff, 0x04)

    const s = h.snapshot()
    expect(s['mode']).toBe('standby')
    expect(s['sf']).toBe(11)
    expect(s['bwHz']).toBe(250_000)
    expect(s['crDen']).toBe(5)
    expect(s['txPowerDbm']).toBe(22)
    expect(s['freqHz']).toBe(0x37598a00)
    expect(h.diagnostics.filter((d) => /unimplemented/i.test(d.message))).toEqual([])
  })

  it('raises a single named diagnostic for an unimplemented opcode', () => {
    const h = harness(new Lr1110Model())
    write(h, 0x8005) // BOOT_REBOOT — bootloader command, not on the LoRa path
    expect(h.diagnostics).toHaveLength(1)
    expect(h.diagnostics[0]!.severity).toBe('warn')
    expect(h.diagnostics[0]!.message).toMatch(/unimplemented command 0x8005/)
  })

  it('pulses DIO9/IRQ on TX-done and drops it on CLEAR_IRQ', () => {
    const h = harness(new Lr1110Model())
    write(h, OP.SET_PACKET_TYPE, 0x02)
    write(h, OP.SET_MODULATION_PARAMS, 9, 0x05, 0x05, 0x00)
    write(h, OP.SET_DIO_IRQ_PARAMS, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0)
    write(h, OP.WRITE_BUFFER, 1, 2, 3, 4, 5, 6, 7, 8)
    write(h, OP.SET_TX, 0, 0, 0)

    expect(h.line('IRQ')).toBe(1)
    const irqWord = (poll(h)[2]! << 24) | (poll(h)[3]! << 16) | (poll(h)[4]! << 8) | poll(h)[5]!
    expect(irqWord & (1 << 2)).toBeTruthy() // TX_DONE
    expect(h.meter('airtime')).toBeGreaterThan(0)

    write(h, OP.CLEAR_IRQ, 0xff, 0xff, 0xff, 0xff)
    expect(h.line('IRQ')).toBe(0)
  })

  it('hardware reset via NRESET returns to power-on state', () => {
    const h = harness(new Lr1110Model())
    write(h, OP.SET_RF_FREQUENCY, 0x37, 0x59, 0x8a, 0x00)
    expect(h.snapshot()['freqHz']).toBe(0x37598a00)
    h.signal('NRESET', 0)
    h.signal('NRESET', 1)
    const s = h.snapshot()
    expect(s['freqHz']).toBe(0)
    expect(s['resetCount']).toBe(1)
  })

  it('Inspector config fields move the modulation state', () => {
    const h = harness(new Lr1110Model())
    h.command('setParam', { bw: 500, sf: 7, cr: 6, txPower: 14 })
    const s = h.snapshot()
    expect(s['bwHz']).toBe(500_000)
    expect(s['sf']).toBe(7)
    expect(s['crDen']).toBe(6)
    expect(s['txPowerDbm']).toBe(14)
  })

  describe('IN-panel injection (M7.3)', () => {
    function configured(): ReturnType<typeof harness> {
      const h = harness(new Lr1110Model())
      write(h, OP.SET_PACKET_TYPE, 0x02)
      write(h, OP.SET_MODULATION_PARAMS, 11, 0x05, 0x05, 0x00) // SF11 BW250 CR4/5
      write(h, OP.SET_DIO_IRQ_PARAMS, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0)
      write(h, OP.SET_RX, 0, 0, 0)
      return h
    }

    it('a channel message raises RX-done, pulses DIO9, and fills the RX buffer', () => {
      const h = configured()
      h.command('inject', { kind: 'channel', text: 'trailhead in 20', rssi: -74, snr: 9 })
      expect(h.line('IRQ')).toBe(1)
      const irq = (poll(h)[2]! << 24) | (poll(h)[3]! << 16) | (poll(h)[4]! << 8) | poll(h)[5]!
      expect(irq & (1 << 3)).toBeTruthy() // RX_DONE
      const s = h.snapshot()
      expect(s['rxCount']).toBe(1)
      expect(s['lastRssi']).toBe(-74)
      expect(s['lastSnr']).toBe(9)
      expect(s['lastAirtimeMs']).toBeGreaterThan(0)
      // GET_RX_BUFFER_STATUS reports a non-zero payload length.
      expect(read(h, 0x0203, [], 2)[1]).toBeGreaterThan(0)
      // READ_BUFFER returns the injected bytes (type 0x10 = channel message).
      const status = read(h, 0x0203, [], 2)
      const len = status[1]!
      expect(read(h, 0x010a, [0, len], len)[1]).toBe(0x10)
    })

    it('an advert and an ack each raise RX-done with the right RSSI', () => {
      const h = configured()
      h.command('inject', { kind: 'advert', from: 0x11223344, hops: 3, rssi: -88 })
      expect(h.snapshot()['lastRssi']).toBe(-88)
      write(h, OP.CLEAR_IRQ, 0xff, 0xff, 0xff, 0xff)
      h.command('inject', { kind: 'ack', rssi: -60 })
      expect(h.line('IRQ')).toBe(1)
      expect(h.snapshot()['rxCount']).toBe(2)
    })

    it('a noise burst moves the floor without raising an IRQ', () => {
      const h = configured()
      h.command('inject', { kind: 'noise', floor: -95 })
      expect(h.line('IRQ')).toBe(0)
      const s = h.snapshot()
      expect(s['noiseFloorDbm']).toBe(-95)
      expect(s['rxCount']).toBe(0)
    })

    it('the airtime meter tracks the active modulation for an injected frame', () => {
      const h = configured()
      h.command('inject', { kind: 'channel', text: 'x'.repeat(40) })
      const slow = h.meter('airtime')!
      h.command('setParam', { sf: 7 })
      h.command('inject', { kind: 'channel', text: 'x'.repeat(40) })
      expect(h.meter('airtime')!).toBeLessThan(slow) // SF7 is faster than SF11
    })
  })
})

describe('loraToaMs', () => {
  it('matches the Semtech airtime formula for a known point', () => {
    // SF7, BW125 kHz, CR4/5, 20-byte payload ≈ 56 ms (LoRa calculator).
    const toa = loraToaMs(7, 125_000, 5, 20)
    expect(toa).toBeGreaterThan(45)
    expect(toa).toBeLessThan(75)
  })

  it('grows with spreading factor', () => {
    expect(loraToaMs(11, 250_000, 5, 32)).toBeGreaterThan(loraToaMs(7, 250_000, 5, 32))
  })
})
