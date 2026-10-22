import { describe, expect, it } from 'vitest'
import {
  canTransition,
  qemuBinaryFor,
  transition,
  INITIAL_STATUS,
  networkArgs,
  uart1Args,
  wifiWrapBuildFlags
} from './emulator'
import type { EmulatorState } from './emulator'

describe('emulator state machine', () => {
  it('starts idle', () => {
    expect(INITIAL_STATUS.state).toBe('idle')
  })

  const validPaths: [EmulatorState, EmulatorState][] = [
    ['idle', 'starting'],
    ['starting', 'running'],
    ['starting', 'crashed'],
    ['starting', 'stopping'],
    ['running', 'stopping'],
    ['running', 'crashed'],
    ['stopping', 'idle'],
    ['stopping', 'crashed'],
    ['crashed', 'starting'],
    ['crashed', 'idle']
  ]

  for (const [from, to] of validPaths) {
    it(`allows ${from} → ${to}`, () => {
      expect(canTransition(from, to)).toBe(true)
      expect(transition(from, to)).toBe(to)
    })
  }

  const invalidPaths: [EmulatorState, EmulatorState][] = [
    ['idle', 'running'],
    ['idle', 'stopping'],
    ['idle', 'crashed'],
    ['running', 'starting'],
    ['running', 'idle'],
    ['crashed', 'running'],
    ['crashed', 'stopping']
  ]

  for (const [from, to] of invalidPaths) {
    it(`rejects ${from} → ${to}`, () => {
      expect(canTransition(from, to)).toBe(false)
      expect(() => transition(from, to)).toThrow('Invalid emulator transition')
    })
  }
})

describe('emulator network helpers', () => {
  it('returns QEMU args for user network mode', () => {
    expect(networkArgs('user')).toEqual(['-nic', 'user,model=open_eth'])
    expect(networkArgs('none')).toEqual([])
    expect(uart1Args('/tmp/u.sock')).toEqual([
      '-chardev',
      'socket,id=pbuart1,path=/tmp/u.sock',
      '-serial',
      'chardev:pbuart1'
    ])
    expect(uart1Args(null)).toEqual([])
    expect(networkArgs(undefined)).toEqual([])
  })

  it('generates build and wrap flags for Wi-Fi emulation', () => {
    const flags = wifiWrapBuildFlags()
    expect(flags).toContain('-DPINBENCH_EMULATED_NET=1')
    expect(flags).toContain('-Wl,--wrap=esp_wifi_init')
    expect(flags).toContain('-Wl,--wrap=esp_wifi_start')
    expect(flags).toContain('-Wl,--wrap=esp_wifi_connect')
    expect(flags).toContain('-Wl,--wrap=esp_wifi_scan_start')
  })
})

describe('qemuBinaryFor', () => {
  it('runs the S3 (and the default) on Xtensa', () => {
    expect(qemuBinaryFor('esp32s3')).toBe('qemu-system-xtensa')
    expect(qemuBinaryFor(undefined)).toBe('qemu-system-xtensa')
  })

  it('runs the RISC-V C3 / C6 on riscv32', () => {
    expect(qemuBinaryFor('esp32c6')).toBe('qemu-system-riscv32')
    expect(qemuBinaryFor('esp32c3')).toBe('qemu-system-riscv32')
  })
})
