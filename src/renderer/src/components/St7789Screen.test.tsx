import { describe, expect, it } from 'vitest'
import { displayDirtyRect } from './St7789Screen'

describe('displayDirtyRect', () => {
  it('maps a GRAM rect straight through without MV', () => {
    const r = displayDirtyRect(false, 240, 320, { x: 10, y: 20, w: 4, h: 6 })
    expect(r).toEqual({ x0: 10, y0: 20, x1: 14, y1: 26 })
  })

  it('transposes the rect for MV — display x is GRAM physY', () => {
    // GRAM (physX 112..117, physY 135..135) → landscape (dx 135..135, dy 112..117).
    const r = displayDirtyRect(true, 320, 240, { x: 112, y: 135, w: 6, h: 1 })
    expect(r).toEqual({ x0: 135, y0: 112, x1: 136, y1: 118 })
  })

  it('clamps a rect that runs past the canvas', () => {
    const r = displayDirtyRect(true, 320, 240, { x: 230, y: 300, w: 40, h: 40 })
    expect(r).toEqual({ x0: 300, y0: 230, x1: 320, y1: 240 })
  })
})
