import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { FLASH_LAYOUT, flashRegionArgs, mergeBinArgs, parseHexToBuffer, parseSize } from './flash'

describe('parseSize', () => {
  it('understands the units pio and QEMU use', () => {
    expect(parseSize('8M')).toBe(8 * 1024 * 1024)
    expect(parseSize('16MB')).toBe(16 * 1024 * 1024)
    expect(parseSize('4194304')).toBe(4194304)
    expect(parseSize('2G')).toBe(2 * 1024 ** 3)
  })

  it('throws on nonsense', () => {
    expect(() => parseSize('lots')).toThrow()
  })
})

describe('mergeBinArgs', () => {
  const args = mergeBinArgs({
    buildDir: '/b',
    bootApp0: '/pio/boot_app0.bin',
    out: '/out/flash.bin',
    sizeBytes: 8 * 1024 * 1024,
    join
  })

  it('targets esp32s3 in DIO at the Arduino-ESP32 offsets', () => {
    expect(args.slice(0, 5)).toEqual(['--chip', 'esp32s3', 'merge_bin', '-o', '/out/flash.bin'])
    expect(args).toContain('--flash_mode')
    expect(args[args.indexOf('--flash_mode') + 1]).toBe('dio')
    expect(args).toEqual(
      expect.arrayContaining([
        '0x0',
        join('/b', 'bootloader.bin'),
        '0x8000',
        join('/b', 'partitions.bin'),
        '0xe000',
        '/pio/boot_app0.bin',
        '0x10000',
        join('/b', 'firmware.bin')
      ])
    )
  })

  it('sets the flash size in whole megabytes', () => {
    expect(args[args.indexOf('--flash_size') + 1]).toBe('8MB')
    expect(args[args.indexOf('--fill-flash-size') + 1]).toBe('8MB')
  })

  it('takes the chip from the board, defaulting to esp32s3', () => {
    expect(args[args.indexOf('--chip') + 1]).toBe('esp32s3')
    const c6 = mergeBinArgs({
      buildDir: '/b',
      bootApp0: '/p/boot_app0.bin',
      out: '/o.bin',
      sizeBytes: 4 * 1024 * 1024,
      chip: 'esp32c6',
      join
    })
    expect(c6[c6.indexOf('--chip') + 1]).toBe('esp32c6')
  })
})

describe('FLASH_LAYOUT', () => {
  it('is the Arduino-ESP32 four-region layout', () => {
    expect(FLASH_LAYOUT.map((r) => r.offset)).toEqual(['0x0', '0x8000', '0xe000', '0x10000'])
    expect(FLASH_LAYOUT.find((r) => r.offset === '0xe000')?.bootApp0).toBe(true)
  })

  it('resolves regions to offset/file pairs, boot_app0 from the core dir', () => {
    expect(flashRegionArgs('/b', '/pio/boot_app0.bin', join)).toEqual([
      '0x0',
      join('/b', 'bootloader.bin'),
      '0x8000',
      join('/b', 'partitions.bin'),
      '0xe000',
      '/pio/boot_app0.bin',
      '0x10000',
      join('/b', 'firmware.bin')
    ])
  })
})

describe('parseHexToBuffer', () => {
  it('parses Intel HEX data into a padded binary buffer', () => {
    const hex = ':020000040000FA\n:04001000DEADBEEF68\n:00000001FF\n'
    const buf = parseHexToBuffer(hex, 64)
    expect(buf.length).toBe(64)
    expect(buf[0x10]).toBe(0xde)
    expect(buf[0x11]).toBe(0xad)
    expect(buf[0x12]).toBe(0xbe)
    expect(buf[0x13]).toBe(0xef)
    expect(buf[0x00]).toBe(0xff)
    expect(buf[0x20]).toBe(0xff)
  })
})
