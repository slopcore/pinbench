import { describe, expect, it } from 'vitest'
import { STIMULI, stimuliFor } from './stimuli'

describe('stimuliFor', () => {
  it('returns the groups for a known model and [] otherwise', () => {
    expect(stimuliFor('pinbench.power').length).toBeGreaterThan(0)
    expect(stimuliFor('sitronix.st7789')).toEqual([])
    expect(stimuliFor(undefined)).toEqual([])
  })

  it('every button has a non-empty command', () => {
    for (const groups of Object.values(STIMULI)) {
      for (const group of groups) {
        expect(group.buttons.length).toBeGreaterThan(0)
        for (const button of group.buttons) {
          expect(button.command).toBeTruthy()
          expect(button.label).toBeTruthy()
        }
      }
    }
  })

  it('covers the sensor cluster (RTC / IMU / magnetometer)', () => {
    const titles = stimuliFor('pinbench.i2c-cluster').map((g) => g.title)
    expect(titles).toEqual(expect.arrayContaining(['RTC', 'IMU', 'Magnetometer']))
  })
})
