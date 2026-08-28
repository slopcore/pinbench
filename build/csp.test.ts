import { describe, expect, it } from 'vitest'
import { DEVELOPMENT_CSP, PRODUCTION_CSP, cspFor } from './csp'

describe('the renderer CSP', () => {
  it('allows the renderer no network at all in a build', () => {
    expect(PRODUCTION_CSP).toContain("default-src 'none'")
    expect(PRODUCTION_CSP).toContain("script-src 'self'")
    expect(PRODUCTION_CSP).not.toContain('unsafe-inline; ')
    // Fonts are bundled, so no host is ever needed for one.
    expect(PRODUCTION_CSP).not.toMatch(/https?:/)
  })

  it('never ships the loosened development policy', () => {
    expect(cspFor(false)).toBe(PRODUCTION_CSP)
    expect(PRODUCTION_CSP).not.toContain('unsafe-eval')
    expect(PRODUCTION_CSP).not.toContain('ws:')
  })

  it('gives the dev server only what hot reload needs', () => {
    expect(cspFor(true)).toBe(DEVELOPMENT_CSP)
    expect(DEVELOPMENT_CSP).toContain("'unsafe-eval'")
    expect(DEVELOPMENT_CSP).toContain('ws:')
    expect(DEVELOPMENT_CSP).toContain("default-src 'none'")
  })
})
