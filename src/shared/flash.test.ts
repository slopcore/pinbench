import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mergeBinArgs, parseSize } from './flash'

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
})
