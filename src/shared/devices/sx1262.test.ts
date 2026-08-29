import { describe, expect, it } from 'vitest'
import { harness } from './harness'
import { Lr1110Model } from './lr1110'
import { Sx1262Model } from './sx1262'

const BUS = 'spi-radio'

/** One SX126x transaction: opcode byte then params, all in one NSS group. */
function xfer(h: ReturnType<typeof harness>, ...bytes: number[]): Uint8Array {
  return h.bus({ bus: BUS, kind: 'spi', select: 'NSS', mosi: Uint8Array.from(bytes) })
}

/** SX126x status parse (RadioLib SPIparseStatus): bits 3:1 must not be a failure code. */
function statusOk(byte: number): boolean {
  const s = byte & 0b1110
  return s !== 0b0110 && s !== 0b1000 && s !== 0b1010
}

describe('Sx1262Model', () => {
  it('comes up in standby with a clean status byte', () => {
    const h = harness(new Sx1262Model())
    expect(h.snapshot()['mode']).toBe('standby')
    const miso = xfer(h, 0xc0, 0x00, 0x00) // GET_STATUS
    expect(statusOk(miso[1]!)).toBe(true)
  })

  it('reports "SX1262" from the version register so RadioLib findChip() passes', () => {
    const h = harness(new Sx1262Model())
    // SPIreadRegisterBurst(0x0320, 16): [0x1D, addrHi, addrLo, NOP, ...16 zero bytes]
    const mosi = [0x1d, 0x03, 0x20, 0x00, ...new Array<number>(16).fill(0)]
    const miso = xfer(h, ...mosi)
    // Register data starts at miso[cmdLen + 1] = miso[4].
    const version = String.fromCharCode(...miso.slice(4, 4 + 6))
    expect(version).toBe('SX1262')
    expect(statusOk(miso[1]!)).toBe(true)
  })

  it('runs a RadioLib-shaped bring-up without a diagnostic', () => {
    const h = harness(new Sx1262Model())
    xfer(h, 0x80, 0x00) // SET_STANDBY (STDBY_RC)
    xfer(h, 0x9d, 0x01) // SET_DIO2_AS_RF_SWITCH — must NOT diagnose
    xfer(h, 0x97, 0x07, 0x00, 0x00, 0x64) // SET_DIO3_AS_TCXO — must NOT diagnose
    xfer(h, 0x8a, 0x01) // SET_PACKET_TYPE LoRa
    xfer(h, 0x86, 0x36, 0x41, 0x24, 0x76) // SET_RF_FREQUENCY (~868.1 MHz)
    xfer(h, 0x8b, 0x0b, 0x05, 0x01, 0x00) // SET_MODULATION_PARAMS SF11 BW250 CR4/5
    xfer(h, 0x8c, 0x00, 0x08, 0x00, 0x10, 0x01, 0x00) // SET_PACKET_PARAMS, 16-byte payload
    xfer(h, 0x8e, 0x16, 0x02) // SET_TX_PARAMS 22 dBm
    xfer(h, 0x08, 0x40, 0x03, 0x40, 0x03, 0x00, 0x00, 0x00, 0x00) // SET_DIO_IRQ_PARAMS
    expect(h.diagnostics).toEqual([])
    const s = h.snapshot()
    expect(s['packetType']).toBe('LoRa')
    expect(s['sf']).toBe(11)
    expect(s['bwHz']).toBe(250000)
    expect(s['crDen']).toBe(5)
    expect(s['txPowerDbm']).toBe(22)
    expect(Math.round((s['freqHz'] as number) / 1e5)).toBe(8681) // ~868.1 MHz
  })

  it('drives BUSY around a command and DIO1 on TX done', () => {
    const h = harness(new Sx1262Model())
    xfer(h, 0x8a, 0x01)
    xfer(h, 0x8b, 0x09, 0x04, 0x01, 0x00) // SF9 BW125 CR4/5
    xfer(h, 0x8c, 0x00, 0x08, 0x00, 0x20, 0x01, 0x00) // 32-byte payload
    xfer(h, 0x08, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00) // IRQ mask all, DIO1 all
    h.driven.length = 0
    xfer(h, 0x83, 0x00, 0x00, 0x00) // SET_TX

    // BUSY went high then low again within the transaction; DIO1 asserted on TX_DONE.
    expect(h.driven).toContainEqual({ signal: 'BUSY', level: 1 })
    expect(h.driven).toContainEqual({ signal: 'BUSY', level: 0 })
    expect(h.line('BUSY')).toBe(0)
    expect(h.line('DIO1')).toBe(1)
    expect(h.meter('airtime')).toBeGreaterThan(0)

    // CLEAR_IRQ_STATUS drops DIO1.
    xfer(h, 0x02, 0xff, 0xff)
    expect(h.line('DIO1')).toBe(0)
  })

  it('computes the same airtime as the LR1110 model for identical LoRa params', () => {
    // SX1262: SF10 BW125 CR4/5, 40-byte payload.
    const sx = harness(new Sx1262Model())
    xfer(sx, 0x8a, 0x01)
    xfer(sx, 0x8b, 0x0a, 0x04, 0x01, 0x00)
    xfer(sx, 0x8c, 0x00, 0x08, 0x00, 0x28, 0x01, 0x00) // payloadLen = 0x28 = 40
    xfer(sx, 0x83, 0x00, 0x00, 0x00) // SET_TX
    const sxAirtime = sx.meter('airtime')

    // LR1110: same SF/BW/CR via its IN-panel setParam, 40-byte TX buffer.
    const lr = harness(new Lr1110Model())
    lr.command('setParam', { sf: 10, bw: 125, cr: 5 })
    lr.bus({
      bus: 'spi0',
      kind: 'spi',
      select: 'NSS',
      mosi: Uint8Array.from([0x01, 0x09, ...new Array<number>(40).fill(0)]) // WRITE_BUFFER, 40 B
    })
    lr.bus({ bus: 'spi0', kind: 'spi', select: 'NSS', mosi: Uint8Array.from([0x02, 0x0a]) }) // SET_TX
    const lrAirtime = lr.meter('airtime')

    expect(sxAirtime).toBeGreaterThan(0)
    expect(sxAirtime).toBe(lrAirtime)
  })

  it('raises a named diagnostic for an unknown opcode', () => {
    const h = harness(new Sx1262Model())
    xfer(h, 0x55, 0x00)
    expect(h.diagnostics).toEqual([
      { severity: 'warn', message: 'SX1262: unimplemented command 0x55' }
    ])
  })

  it('carries board deviceOptions into the snapshot', () => {
    const h = harness(new Sx1262Model({ dio2RfSwitch: true, dio3TcxoVoltage: 1.8 }))
    const s = h.snapshot()
    expect(s['dio2RfSwitch']).toBe(true)
    expect(s['dio3TcxoVoltage']).toBe(1.8)
  })

  it('fills an injected RX frame and pulses DIO1', () => {
    const h = harness(new Sx1262Model())
    xfer(h, 0x08, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00)
    h.command('inject', { kind: 'channel', text: 'meet at the ridge', rssi: -72, snr: 9 })
    expect(h.line('DIO1')).toBe(1)
    expect(h.snapshot()['rxCount']).toBe(1)
    // GET_RX_BUFFER_STATUS reports the payload length at miso[2].
    const miso = xfer(h, 0x13, 0x00, 0x00)
    expect(miso[2]).toBeGreaterThan(0)
  })
})
