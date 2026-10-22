import { describe, expect, it } from 'vitest'
import { netColour, netFilterKind } from './nets'
import type { BoardDefinition } from './board'

const buses: BoardDefinition['buses'] = [
  { id: 'spi0', kind: 'spi', label: 'SPI0', signals: {} },
  { id: 'i2c0', kind: 'i2c', label: 'I2C0', signals: {} },
  { id: 'uart1', kind: 'uart', label: 'UART1', signals: {} },
  { id: 'ow', kind: 'onewire', label: '1-Wire', signals: {} }
]

describe('netColour', () => {
  it('maps each bus kind to a token and loose nets to neutral', () => {
    expect(netColour('spi0', buses)).toBe('var(--accent-500)')
    expect(netColour('i2c0', buses)).toBe('var(--accent-2-500)')
    expect(netColour('uart1', buses)).toBe('var(--status-warn)')
    expect(netColour(undefined, buses)).toBe('var(--neutral-600)')
  })
})

describe('netFilterKind', () => {
  it('classifies bus nets, loose nets as gpio, and onewire as unfilterable', () => {
    expect(netFilterKind('spi0', buses)).toBe('spi')
    expect(netFilterKind('i2c0', buses)).toBe('i2c')
    expect(netFilterKind('uart1', buses)).toBe('uart')
    expect(netFilterKind(undefined, buses)).toBe('gpio')
    expect(netFilterKind('ow', buses)).toBeNull()
  })
})
