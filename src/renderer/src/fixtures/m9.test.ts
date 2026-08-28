import { describe, expect, it } from 'vitest'
import { boardTotals, findPart, partsByCategory } from '@shared/board'
import { M9_BOARD } from './m9'

describe('boardTotals', () => {
  it('computes the counts the status bar shows', () => {
    // The design's footer reads "9 parts · 12 nets · 31 GPIO assigned" for the
    // bare M9; M4 adds the demo LED on GPIO45 (deleted with this fixture at
    // M5). Either way the numbers come from the definition, never a string.
    expect(boardTotals(M9_BOARD)).toEqual({ parts: 10, nets: 12, assignedGpio: 32 })
  })

  it('counts a pin shared by several parts once', () => {
    const shared = {
      ...M9_BOARD,
      parts: M9_BOARD.parts.filter((part) => ['u2', 'u3', 'u4'].includes(part.id))
    }
    const sck = shared.parts.filter((part) => part.pins.some((binding) => binding.pin === 'GPIO40'))
    expect(sck).toHaveLength(3)
    expect(boardTotals(shared).assignedGpio).toBeLessThan(
      shared.parts.reduce((total, part) => total + part.pins.length, 0)
    )
  })
})

describe('the M9 fixture', () => {
  it('binds every part pin to a pin the board declares', () => {
    const declared = new Set(M9_BOARD.pins.map((pin) => pin.id))
    for (const part of M9_BOARD.parts) {
      for (const binding of part.pins) {
        expect(declared.has(binding.pin), `${part.designator}.${binding.signal}`).toBe(true)
      }
    }
  })

  it('names only buses the board declares', () => {
    const declared = new Set(M9_BOARD.buses.map((bus) => bus.id))
    for (const part of M9_BOARD.parts) {
      for (const bus of part.buses) expect(declared.has(bus)).toBe(true)
    }
    for (const net of M9_BOARD.nets) {
      if (net.bus !== undefined) expect(declared.has(net.bus)).toBe(true)
    }
  })

  it('points every net endpoint at a real part signal', () => {
    for (const net of M9_BOARD.nets) {
      for (const node of net.nodes) {
        if (!node.includes(':')) continue
        const [partId, signal] = node.split(':')
        const part = findPart(M9_BOARD, partId ?? '')
        expect(part, node).toBeDefined()
        expect(
          part?.pins.some((binding) => binding.signal === signal),
          node
        ).toBe(true)
      }
    }
  })

  it('carries the pin map the roadmap records', () => {
    const pinFor = (partId: string, signal: string): string | undefined =>
      findPart(M9_BOARD, partId)?.pins.find((binding) => binding.signal === signal)?.pin
    expect(pinFor('u2', 'SCK')).toBe('GPIO40')
    expect(pinFor('u2', 'MOSI')).toBe('GPIO47')
    expect(pinFor('u2', 'MISO')).toBe('GPIO38')
    expect(pinFor('u2', 'NSS')).toBe('GPIO39')
    expect(pinFor('u3', 'CS')).toBe('GPIO16')
    expect(pinFor('u4', 'CS')).toBe('GPIO48')
    expect(pinFor('u9', 'VDD_PERIPH')).toBe('GPIO18')
    expect(pinFor('u9', 'BUZZER')).toBe('GPIO9')
    const i2c0 = M9_BOARD.buses.find((bus) => bus.id === 'i2c0')
    expect(i2c0?.signals).toEqual({ sda: 'GPIO7', scl: 'GPIO6' })
    expect(i2c0?.clockHz).toBe(400_000)
  })

  it('has exactly one processor to hang the diagram off', () => {
    expect(partsByCategory(M9_BOARD).get('mcu')).toHaveLength(1)
  })
})
