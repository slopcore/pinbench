import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  availableBoardIds,
  boardsDir,
  DEFAULT_BOARD_ID,
  loadBoard,
  saveBoardProfile
} from './board'

describe('loadBoard', () => {
  it('reads and validates the shipped M9 definition', () => {
    const board = loadBoard('thinknode-m9-v1.0')
    expect(board.id).toBe('thinknode-m9-v1.0')
    expect(board.emulator.psramOctal).toBe(true)
  })

  it('resolves to the named default when no id is given, regardless of what else is on disk', () => {
    // More than one *.board.json now ships; an id-less load must still be the M9.
    expect(availableBoardIds().length).toBeGreaterThan(1)
    expect(availableBoardIds()).toContain(DEFAULT_BOARD_ID)
    expect(loadBoard().id).toBe(DEFAULT_BOARD_ID)
    expect(loadBoard('').id).toBe(DEFAULT_BOARD_ID)
    expect(loadBoard(undefined).id).toBe(DEFAULT_BOARD_ID)
  })

  it('reads and validates the Heltec Wireless Paper definition', () => {
    const board = loadBoard('heltec-wireless-paper-v1.1')
    expect(board.id).toBe('heltec-wireless-paper-v1.1')
    expect(board.vendor).toBe('Heltec')
    // Two SPI buses — the radio and the e-ink panel do not share one.
    expect(
      board.buses
        .filter((b) => b.kind === 'spi')
        .map((b) => b.id)
        .sort()
    ).toEqual(['spi-disp', 'spi-radio'])
    // No PSRAM on this part.
    expect(board.emulator.psramSize).toBeUndefined()
    expect(board.emulator.flashSize).toBe('8M')
  })

  it('reads and validates the Waveshare ESP32-C6-Touch-LCD-1.28 definition', () => {
    const board = loadBoard('waveshare-esp32-c6-touch-lcd-1.28')
    expect(board.vendor).toBe('Waveshare')
    expect(board.mcu).toBe('ESP32-C6')
    expect(board.emulator.machine).toBe('esp32c6')
    expect(board.emulator.flashSize).toBe('16M')
    expect(board.emulator.psramSize).toBeUndefined()
    // LCD and TF card share one SPI bus; touch, IMU and RTC share one I2C bus.
    const spi = board.buses.filter((b) => b.kind === 'spi')
    expect(spi.map((b) => b.signals)).toEqual([{ sck: 'GPIO11', mosi: 'GPIO21', miso: 'GPIO22' }])
    const lcd = board.parts.find((p) => p.mpn === 'GC9A01')
    expect(lcd?.deviceModel).toBe('galaxycore.gc9a01')
    expect(lcd?.pins).toContainEqual({ signal: 'DC', pin: 'GPIO19' })
    // GPIO14 is not bonded out; 24–30 are the flash.
    expect(board.pins.map((p) => p.id)).not.toContain('GPIO14')
    expect(board.pinExceptions).toEqual(['GPIO4', 'GPIO23'])
  })

  it('reads and validates the Waveshare ESP32-S3-ETH + round LCD + TWN4 kit', () => {
    const board = loadBoard('waveshare-esp32-s3-eth-gc9a01-twn4')
    expect(board.mcu).toBe('ESP32-S3')
    expect(board.emulator).toMatchObject({ machine: 'esp32s3', psramOctal: true, flashSize: '16M' })
    const eth = board.parts.find((p) => p.mpn === 'W5500')
    expect(eth?.deviceModel).toBe('wiznet.w5500')
    expect(eth?.pins).toContainEqual({ signal: 'CS', pin: 'GPIO14' })
    expect(board.parts.find((p) => p.mpn === 'GC9A01')?.deviceModel).toBe('galaxycore.gc9a01')
    // The reader hangs off UART1, which the emulator serves to its model.
    const reader = board.parts.find((p) => p.deviceModel === 'elatec.twn4')
    expect(reader?.buses).toEqual(['uart1'])
    expect(board.buses.find((b) => b.id === 'uart1')?.controller).toBe(1)
  })

  it('reads and validates the ThinkNode M1 definition', () => {
    const board = loadBoard('thinknode-m1-v1.0')
    expect(board.id).toBe('thinknode-m1-v1.0')
    expect(board.vendor).toBe('Elecrow')
    expect(board.mcu).toBe('nRF52840')
    expect(board.emulator.machine).toBe('esp32s3')
    expect(board.firmware?.env).toBe('ThinkNode_M1_companion_radio_ble')
    expect(board.firmware?.envMatch).toBe('thinknode_m1')
    expect(board.parts).toHaveLength(6)
  })

  it('rejects an id with path characters before touching the filesystem', () => {
    expect(() => loadBoard('../secrets')).toThrow(/invalid board id/)
    expect(() => loadBoard('a/b')).toThrow(/invalid board id/)
  })

  it('throws a helpful error for a missing file', () => {
    expect(() => loadBoard('no-such-board')).toThrow(/no board definition at/)
  })

  it('resolves board files under a boards/ directory', () => {
    expect(boardsDir()).toMatch(/boards$/)
  })
})

describe('saveBoardProfile', () => {
  const SCRATCH_ID = 'zz-test-tmp-profile'
  afterEach(() => {
    rmSync(join(boardsDir(), `${SCRATCH_ID}.board.json`), { force: true })
  })

  it('writes a validated definition that loadBoard round-trips, id forced to match', () => {
    const source = loadBoard('heltec-wireless-paper-v1.1')
    // Pass a mismatched id in the body — the filename wins.
    const written = saveBoardProfile(SCRATCH_ID, { ...source, id: 'something-else' })
    expect(written.id).toBe(SCRATCH_ID)
    expect(loadBoard(SCRATCH_ID).id).toBe(SCRATCH_ID)
    expect(availableBoardIds()).toContain(SCRATCH_ID)
  })

  it('rejects an id with path characters before touching the filesystem', () => {
    expect(() => saveBoardProfile('../evil', {})).toThrow(/invalid board id/)
    expect(() => saveBoardProfile('a/b', {})).toThrow(/invalid board id/)
  })

  it('rejects a definition that fails board validation', () => {
    expect(() => saveBoardProfile(SCRATCH_ID, { schema: 1, id: SCRATCH_ID })).toThrow()
    expect(availableBoardIds()).not.toContain(SCRATCH_ID)
  })
})
