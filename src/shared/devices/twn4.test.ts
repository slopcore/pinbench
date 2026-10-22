import { describe, expect, it } from 'vitest'
import { harness } from './harness'
import { TWN4_VERSION, Twn4Model, twn4Descriptor } from './twn4'

describe('Twn4Model (Simple Protocol, ASCII)', () => {
  it('answers SearchTag with "no tag" until a card is presented', () => {
    const r = harness(new Twn4Model())
    r.uart('050010\r')
    expect(r.takeUartText()).toBe('0000\r')

    r.command('present', { uid: '04A1B2C3', type: 'mifare' })
    r.uart('050010\r')
    // status 00, found 01, MIFARE 0x80, 32 bits, 4 bytes, the UID.
    expect(r.takeUartText()).toBe('0001802004' + '04A1B2C3\r')
    expect(r.meter('reads')).toBe(1)

    r.command('remove')
    r.uart('050010\r')
    expect(r.takeUartText()).toBe('0000\r')
  })

  it('reassembles a command split across UART chunks and ignores LF', () => {
    const r = harness(new Twn4Model())
    r.uart('00')
    r.uart('04')
    r.uart('FF\r\n')
    const reply = r.takeUartText()
    expect(reply.startsWith('00')).toBe(true)
    const len = parseInt(reply.slice(2, 4), 16)
    expect(len).toBe(TWN4_VERSION.length)
    const text = reply
      .slice(4, -1)
      .match(/../g)!
      .map((h) => String.fromCharCode(parseInt(h, 16)))
      .join('')
    expect(text).toBe(TWN4_VERSION)
  })

  it('truncates the ID to MaxIDBytes but reports the full bit count', () => {
    const r = harness(new Twn4Model())
    r.command('present', { uid: '0102030405060708', type: 'iso15693' })
    r.uart('050002\r')
    expect(r.takeUartText()).toBe('0001824002' + '0102\r')
  })

  it('filters by SetTagTypes and restores with GetTagTypes', () => {
    const r = harness(new Twn4Model())
    r.command('present', { uid: '1122334455', type: 'em4102' })
    // LF mask: EM4102 is 0x40 → bit 0. Enable HF only.
    r.uart('050200000000FF0F0000\r')
    expect(r.takeUartText()).toBe('00\r')
    r.uart('050010\r')
    expect(r.takeUartText()).toBe('0000\r')
    r.uart('0503\r')
    expect(r.takeUartText()).toBe('0000000000FF0F0000\r')
    r.uart('05020100000000000000\r')
    r.takeUartText()
    r.uart('050010\r')
    expect(r.takeUartText()).toBe('0001402805' + '1122334455\r')
  })

  it('drives LEDs through the GPIO API and logs a beep', () => {
    const r = harness(new Twn4Model())
    r.uart('040202\r')
    expect(r.takeUartText()).toBe('00\r')
    expect(r.snapshot()).toMatchObject({ leds: { red: false, green: true } })
    r.uart('040601\r')
    expect(r.takeUartText()).toBe('0001\r')
    r.uart('04071E6009F4010000\r')
    expect(r.takeUartText()).toBe('00\r')
    expect(r.events.at(-1)).toMatchObject({
      kind: 'beep',
      summary: 'Beep 2400 Hz for 500 ms at volume 30'
    })
    expect(r.meter('beeps')).toBe(1)
  })

  it('reports parser, parameter and unknown-function errors loudly', () => {
    const r = harness(new Twn4Model())
    r.uart('xyz\r')
    expect(r.takeUartText()).toBe('05\r')
    r.uart('0500\r')
    expect(r.takeUartText()).toBe('02\r')
    r.uart('05011234\r')
    expect(r.takeUartText()).toBe('03\r')
    r.uart('0F00\r')
    expect(r.takeUartText()).toBe('01\r')
    expect(r.diagnostics.some((d) => d.severity === 'error' && /0F00/.test(d.message))).toBe(true)
  })
})

describe('Twn4Model (plain ID output)', () => {
  it('prints the UID once per presentation and ignores host bytes', () => {
    const r = harness(twn4Descriptor.create({ protocol: 'id' }))
    r.uart('050010\r')
    expect(r.takeUartText()).toBe('')
    r.command('present', { uid: 'deadbeef' })
    expect(r.takeUartText()).toBe('DEADBEEF\r')
    expect(r.snapshot()).toMatchObject({
      protocol: 'id',
      card: { type: 'mifare', uid: 'DEADBEEF' }
    })
  })

  it('rejects a malformed UID without changing the card', () => {
    const r = harness(twn4Descriptor.create({ protocol: 'id' }))
    r.command('present', { uid: 'abc' })
    expect(r.takeUartText()).toBe('')
    expect(r.diagnostics.at(-1)?.severity).toBe('warn')
    expect(r.snapshot()['card']).toBeNull()
  })
})
