import { describe, expect, it } from 'vitest'
import { LineStreamer } from './stream'

describe('LineStreamer', () => {
  it('splits on newlines and buffers a partial line', () => {
    const s = new LineStreamer()
    expect(s.push('one\ntwo').map((seg) => seg.text)).toEqual(['one'])
    expect(s.push('\nthree').map((seg) => seg.text)).toEqual(['two'])
    expect(s.flush()).toEqual({ text: 'three', replace: false })
  })

  it('marks a bare carriage return as a replace segment', () => {
    const s = new LineStreamer()
    const segments = s.push('Downloading 10%\rDownloading 55%\rDownloading 100%\n')
    expect(segments).toEqual([
      { text: 'Downloading 10%', replace: true },
      { text: 'Downloading 55%', replace: true },
      { text: 'Downloading 100%', replace: false }
    ])
  })

  it('treats \\r\\n as one ordinary line terminator', () => {
    const s = new LineStreamer()
    expect(s.push('a\r\nb\r\n')).toEqual([
      { text: 'a', replace: false },
      { text: 'b', replace: false }
    ])
  })

  it('flush returns null when nothing is buffered', () => {
    expect(new LineStreamer().flush()).toBeNull()
  })
})
