import { describe, expect, it } from 'vitest'
import { buildButtonLabel, canTransition, isBuildRunning, phaseFromLine, transition } from './build'

describe('build state machine', () => {
  it('allows the happy path idle → preparing → compiling → linking → merging → done', () => {
    let state = transition('idle', 'preparing')
    state = transition(state, 'compiling')
    state = transition(state, 'linking')
    state = transition(state, 'merging')
    state = transition(state, 'done')
    expect(state).toBe('done')
  })

  it('lets a cached build skip straight from linking to done', () => {
    expect(canTransition('linking', 'done')).toBe(true)
  })

  it('can fail or cancel from any working phase', () => {
    for (const phase of ['preparing', 'compiling', 'linking', 'merging'] as const) {
      expect(canTransition(phase, 'failed')).toBe(true)
      expect(canTransition(phase, 'cancelled')).toBe(true)
    }
  })

  it('only restarts through preparing', () => {
    expect(canTransition('done', 'preparing')).toBe(true)
    expect(canTransition('failed', 'preparing')).toBe(true)
    expect(canTransition('done', 'compiling')).toBe(false)
  })

  it('throws on an illegal jump', () => {
    expect(() => transition('idle', 'merging')).toThrow(/Invalid build transition/)
  })
})

describe('phaseFromLine', () => {
  it('recognises the pio phase banners', () => {
    expect(phaseFromLine('Compiling .pio/build/esp32s3/src/main.cpp.o')).toBe('compiling')
    expect(phaseFromLine('Linking .pio/build/esp32s3/firmware.elf')).toBe('linking')
    expect(phaseFromLine('Building .pio/build/esp32s3/firmware.bin')).toBe('linking')
    expect(phaseFromLine('Retrieving maximum program size .pio/build/...')).toBe('linking')
  })

  it('ignores lines that say nothing about progress', () => {
    expect(phaseFromLine('warning: unused variable x')).toBeNull()
    expect(phaseFromLine('')).toBeNull()
  })
})

describe('buildButtonLabel', () => {
  it('gives the design its cycling labels', () => {
    expect(buildButtonLabel('compiling')).toBe('Compiling…')
    expect(buildButtonLabel('linking')).toBe('Linking…')
    expect(buildButtonLabel('merging')).toBe('Flashing…')
    expect(buildButtonLabel('done')).toBe('Flashed ✓')
    expect(buildButtonLabel('idle')).toBe('Build & flash')
  })
})

describe('isBuildRunning', () => {
  it('is true only for the working phases', () => {
    expect(isBuildRunning('compiling')).toBe(true)
    expect(isBuildRunning('merging')).toBe(true)
    expect(isBuildRunning('done')).toBe(false)
    expect(isBuildRunning('idle')).toBe(false)
  })
})
