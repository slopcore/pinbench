import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  canTransition,
  eraseFlashArgs,
  flashPercentFromLine,
  isUsbFlashRunning,
  parsePortList,
  transition,
  usbFlashButtonLabel,
  writeFlashArgs
} from './usb-flash'

describe('the USB-flash state machine', () => {
  it('runs build → erase → flash → done and can restart', () => {
    expect(canTransition('idle', 'building')).toBe(true)
    expect(canTransition('building', 'erasing')).toBe(true)
    expect(canTransition('building', 'flashing')).toBe(true)
    expect(canTransition('erasing', 'flashing')).toBe(true)
    expect(canTransition('flashing', 'done')).toBe(true)
    expect(canTransition('done', 'building')).toBe(true)
    expect(canTransition('failed', 'building')).toBe(true)
  })

  it('rejects skipping straight to flashing or erasing from idle', () => {
    expect(canTransition('idle', 'flashing')).toBe(false)
    expect(() => transition('idle', 'erasing')).toThrow()
  })

  it('knows which states are in flight', () => {
    expect((['building', 'erasing', 'flashing'] as const).every(isUsbFlashRunning)).toBe(true)
    expect((['idle', 'done', 'failed', 'cancelled'] as const).some(isUsbFlashRunning)).toBe(false)
  })

  it('labels the button per state', () => {
    expect(usbFlashButtonLabel('idle')).toBe('Flash over USB')
    expect(usbFlashButtonLabel('erasing')).toBe('Erasing…')
    expect(usbFlashButtonLabel('done')).toBe('Flashed ✓')
  })
})

describe('parsePortList', () => {
  it('keeps wired ports and drops n/a-hwid virtual entries', () => {
    const ports = parsePortList([
      {
        port: '/dev/cu.usbserial-0001',
        description: 'USB Single Serial',
        hwid: 'USB VID:PID=303A:1001'
      },
      { port: '/dev/cu.Bluetooth-Incoming-Port', description: 'n/a', hwid: 'n/a' }
    ])
    expect(ports).toEqual([
      {
        port: '/dev/cu.usbserial-0001',
        description: 'USB Single Serial',
        hwid: 'USB VID:PID=303A:1001'
      }
    ])
  })

  it('survives junk', () => {
    expect(parsePortList(null)).toEqual([])
    expect(parsePortList([{ description: 'no port key' }, { port: '' }])).toEqual([])
  })
})

describe('esptool argv', () => {
  it('erase_flash targets the chosen chip and port', () => {
    expect(eraseFlashArgs('esp32s3', '/dev/ttyUSB0')).toEqual([
      '--chip',
      'esp32s3',
      '--port',
      '/dev/ttyUSB0',
      '--before',
      'default_reset',
      'erase_flash'
    ])
  })

  it('write_flash detects size and writes only the four regions', () => {
    const args = writeFlashArgs({
      chip: 'esp32s3',
      port: 'COM7',
      buildDir: '/b',
      bootApp0: '/pio/boot_app0.bin',
      join
    })
    expect(args).not.toContain('--fill-flash-size')
    expect(args[args.indexOf('--flash_size') + 1]).toBe('detect')
    expect(args.slice(-8)).toEqual([
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

describe('flashPercentFromLine', () => {
  it('reads esptool progress', () => {
    expect(flashPercentFromLine('Writing at 0x00010000... (37 %)')).toBe(37)
    expect(flashPercentFromLine('Writing at 0x0002c000... (100 %)')).toBe(100)
  })

  it('is null for lines with no percentage', () => {
    expect(flashPercentFromLine('Hash of data verified.')).toBeNull()
    expect(flashPercentFromLine('(120 %)')).toBeNull()
  })
})
