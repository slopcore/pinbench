import { describe, expect, it } from 'vitest'
import {
  decodeFrame,
  encodeFrame,
  FrameDecoder,
  FrameError,
  FRAME_HEADER_BYTES,
  Op,
  signalHash,
  type Frame
} from './protocol'

function sample(payload: Uint8Array, over: Partial<Frame> = {}): Frame {
  return {
    op: Op.Xfer,
    reply: false,
    bus: 2,
    select: 0x0f,
    seq: 7,
    t: 1_234_567_890,
    payload,
    ...over
  }
}

describe('frame codec', () => {
  it('round-trips a frame', () => {
    const frame = sample(new Uint8Array([1, 2, 3, 4, 5]))
    const { frame: back, bytesRead } = decodeFrame(encodeFrame(frame))
    expect(bytesRead).toBe(FRAME_HEADER_BYTES + 5)
    expect(back).toMatchObject({ op: Op.Xfer, bus: 2, select: 0x0f, seq: 7, t: 1_234_567_890 })
    expect([...back.payload]).toEqual([1, 2, 3, 4, 5])
  })

  it('carries a 64-bit-range timestamp exactly', () => {
    const t = 9_000_000_000_000 // ~104 days in ns, still an exact JS integer
    const { frame } = decodeFrame(encodeFrame(sample(new Uint8Array(0), { t })))
    expect(frame.t).toBe(t)
  })

  it('preserves the full 153,600-byte display frame', () => {
    const payload = new Uint8Array(320 * 240 * 2).map((_, i) => i & 0xff)
    const { frame } = decodeFrame(encodeFrame(sample(payload)))
    expect(frame.payload.length).toBe(153_600)
    expect(frame.payload[153_599]).toBe(payload[153_599])
  })

  it('rejects a bad magic', () => {
    const bytes = encodeFrame(sample(new Uint8Array(1)))
    bytes[0] = 0
    expect(() => decodeFrame(bytes)).toThrow(FrameError)
  })

  it('rejects a truncated buffer', () => {
    const bytes = encodeFrame(sample(new Uint8Array([9, 9, 9])))
    expect(() => decodeFrame(bytes.subarray(0, FRAME_HEADER_BYTES + 1))).toThrow(FrameError)
  })
})

describe('FrameDecoder', () => {
  it('reassembles frames split across chunks', () => {
    const a = encodeFrame(sample(new Uint8Array([1, 1])))
    const b = encodeFrame(sample(new Uint8Array([2, 2, 2]), { seq: 8 }))
    const stream = new Uint8Array(a.length + b.length)
    stream.set(a)
    stream.set(b, a.length)

    const decoder = new FrameDecoder()
    const frames: Frame[] = []
    // Feed it one byte at a time — the worst case a socket can hand us.
    for (const byte of stream) frames.push(...decoder.push(new Uint8Array([byte])))

    expect(frames).toHaveLength(2)
    expect([...frames[0]!.payload]).toEqual([1, 1])
    expect(frames[1]!.seq).toBe(8)
    expect(decoder.pending).toBe(0)
  })

  it('does not alias its internal buffer into emitted payloads', () => {
    const decoder = new FrameDecoder()
    const [frame] = decoder.push(encodeFrame(sample(new Uint8Array([5, 6, 7]))))
    decoder.push(encodeFrame(sample(new Uint8Array([0, 0, 0]))))
    expect([...frame!.payload]).toEqual([5, 6, 7])
  })
})

describe('signalHash', () => {
  it('is stable and 16-bit', () => {
    const h = signalHash('ANODE')
    expect(h).toBe(signalHash('ANODE'))
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThanOrEqual(0xffff)
  })

  it('separates the signal names one device actually has', () => {
    const names = ['ANODE', 'NSS', 'BUSY', 'IRQ', 'NRESET', 'DC', 'RST', 'CS']
    expect(new Set(names.map(signalHash)).size).toBe(names.length)
  })
})
