import { describe, expect, it } from 'vitest'
import { boardTotals, findPart, partsByCategory } from '../src/shared/board'
import { M9_BOARD } from './board'

/**
 * The shipped M9 definition, held to the same consistency rules the M1 fixture's
 * test file used to assert — now enforced inside `parseBoard`, so simply loading
 * `M9_BOARD` in `./board.ts` already runs cross-reference validation. These
 * cover the numbers the design and roadmap pin down.
 */
describe('the M9 board definition', () => {
  it('has the counts the design footer shows: 9 parts · 12 nets · 31 GPIO', () => {
    expect(boardTotals(M9_BOARD)).toEqual({ parts: 9, nets: 12, assignedGpio: 31 })
  })

  it('has exactly one processor', () => {
    expect(partsByCategory(M9_BOARD).get('mcu')).toHaveLength(1)
  })

  it('carries the pin map the roadmap records', () => {
    const pinFor = (partId: string, signal: string): string | undefined =>
      findPart(M9_BOARD, partId)?.pins.find((b) => b.signal === signal)?.pin
    // SPI0 and the three chip selects (M5, M6, M8, M9).
    expect(pinFor('u2', 'SCK')).toBe('GPIO40')
    expect(pinFor('u2', 'MOSI')).toBe('GPIO47')
    expect(pinFor('u2', 'MISO')).toBe('GPIO38')
    expect(pinFor('u2', 'NSS')).toBe('GPIO39')
    expect(pinFor('u3', 'CS')).toBe('GPIO16')
    expect(pinFor('u4', 'CS')).toBe('GPIO48')
    // LR1110 control lines (M8).
    expect(pinFor('u2', 'BUSY')).toBe('GPIO41')
    expect(pinFor('u2', 'IRQ')).toBe('GPIO42')
    expect(pinFor('u2', 'NRESET')).toBe('GPIO45')
    // Keyboard on I2C1 with the double-bindable wake line (M7, M11).
    expect(pinFor('u8', 'SDA')).toBe('GPIO20')
    expect(pinFor('u8', 'SCL')).toBe('GPIO21')
    expect(pinFor('u8', 'KEY_INT')).toBe('GPIO12')
    // GNSS on UART1 (M9).
    expect(pinFor('u6', 'PPS')).toBe('GPIO4')
    expect(pinFor('u6', 'EN')).toBe('GPIO11')
    // Power (M10).
    expect(pinFor('u9', 'BAT_ADC')).toBe('GPIO13')
    expect(pinFor('u9', 'VDD_PERIPH')).toBe('GPIO18')
    expect(pinFor('u9', 'BUZZER')).toBe('GPIO9')
  })

  it('carries the LCD backlight polarity as a device option (M9 is active-low)', () => {
    expect(findPart(M9_BOARD, 'u3')?.deviceOptions).toEqual({ backlightActiveHigh: false })
  })

  it('puts the keyboard SCL on the pin M11 moves the LCD CS onto', () => {
    // M11's Done-when: moving LCD_CS to GPIO21 collides with the keyboard's SCL.
    const kbdScl = findPart(M9_BOARD, 'u8')?.pins.find((b) => b.signal === 'SCL')?.pin
    expect(kbdScl).toBe('GPIO21')
  })

  it('has no chip-select collision in the shipped map', () => {
    const cs = ['u2:NSS', 'u3:CS', 'u4:CS'].map((ref) => {
      const [partId, signal] = ref.split(':')
      return findPart(M9_BOARD, partId!)?.pins.find((b) => b.signal === signal)?.pin
    })
    expect(new Set(cs).size).toBe(3)
  })

  it('exposes the octal-PSRAM emulator target', () => {
    expect(M9_BOARD.emulator).toEqual({
      machine: 'esp32s3',
      psramSize: '8M',
      psramOctal: true,
      flashSize: '16M'
    })
  })
})
