import { describe, expect, it } from 'vitest'
import { stripAnsi } from './serial'

describe('stripAnsi', () => {
  it('removes colour codes', () => {
    expect(stripAnsi('\x1b[32mOK\x1b[0m')).toBe('OK')
  })

  it('passes plain text through', () => {
    expect(stripAnsi('hello world')).toBe('hello world')
  })

  it('removes multiple escape sequences', () => {
    expect(stripAnsi('\x1b[1m\x1b[31mERROR\x1b[0m: oops')).toBe('ERROR: oops')
  })
})
