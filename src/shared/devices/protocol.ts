/**
 * The wire protocol between a QEMU bus controller (C, in the fork) and the
 * PinBench device host (Node).
 *
 * ADR 0001 open question 3: the spike moved raw bytes behind a 5-byte header
 * and noted "real traffic carries a device id, a bus id, and probably a
 * timestamp — measure it in M4 once the real protocol exists." This is that
 * protocol. `scripts/bench-framing.mjs` measures its overhead and the ADR
 * amendment records the number.
 *
 * One frame is a fixed 20-byte header then a payload. Every field is
 * little-endian, matching the Xtensa guest and every host PinBench targets, so
 * the C side can memcpy a packed struct and the JS side uses a DataView with no
 * byte-swapping.
 *
 *   off  size  field
 *   0    1     magic   0x9B
 *   1    1     op      Op
 *   2    1     flags   bit0 = reply
 *   3    1     bus     board bus index, or 0xFF for a signal/control frame
 *   4    2     select  SPI cs index or I2C addr, or 0xFFFF for none
 *   6    2     seq     request id, echoed on the reply
 *   8    8     t       nanoseconds since emulator start
 *   16   4     len     payload length in bytes
 *   20   …     payload
 *
 * The transaction budget the ADR warns about is measured in *frames*, not
 * bytes: one `Xfer` request + its reply is two frames and ~40 bytes of header
 * regardless of how large the transfer is.
 */

export const FRAME_MAGIC = 0x9b
export const FRAME_HEADER_BYTES = 20

/** 0xFF in the 1-byte `bus` field: this frame is not about a data bus. */
export const BUS_NONE = 0xff
/** 0xFFFF in the 2-byte `select` field: no chip-select / address. */
export const SELECT_NONE = 0xffff

export const Op = {
  /** Host←guest handshake, payload is an ASCII version tag. Reply echoes it. */
  Hello: 0x01,
  /** A whole bus transaction. Request payload = MOSI, reply payload = MISO. */
  Xfer: 0x02,
  /** The guest drove a line into a device. Payload = 1 byte level (0/1),
   *  `select` carries the device's signal-name hash — see {@link signalHash}.
   *  No reply. */
  Signal: 0x03,
  /** Reset every model to power-on. No payload, no reply. */
  Reset: 0x04
} as const

export type OpCode = (typeof Op)[keyof typeof Op]

export const FLAG_REPLY = 0x01

export interface Frame {
  op: OpCode
  reply: boolean
  bus: number
  select: number
  seq: number
  /** ns since emulator start. A JS `number` holds this exactly to 2^53 ns ≈ 104 days. */
  t: number
  payload: Uint8Array
}

/** Serialise one frame. */
export function encodeFrame(frame: Frame): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES + frame.payload.length)
  const view = new DataView(out.buffer)
  view.setUint8(0, FRAME_MAGIC)
  view.setUint8(1, frame.op)
  view.setUint8(2, frame.reply ? FLAG_REPLY : 0)
  view.setUint8(3, frame.bus & 0xff)
  view.setUint16(4, frame.select & 0xffff, true)
  view.setUint16(6, frame.seq & 0xffff, true)
  // Two 32-bit halves: BigInt64 would force callers to hold BigInts for no gain.
  view.setUint32(8, frame.t >>> 0, true)
  view.setUint32(12, Math.floor(frame.t / 0x100000000) >>> 0, true)
  view.setUint32(16, frame.payload.length, true)
  out.set(frame.payload, FRAME_HEADER_BYTES)
  return out
}

export class FrameError extends Error {}

/**
 * Parse exactly one frame from the front of `buf`. Throws {@link FrameError} on
 * a bad magic or a truncated buffer — callers streaming a socket use
 * {@link FrameDecoder} instead, which tolerates partial reads.
 */
export function decodeFrame(buf: Uint8Array): { frame: Frame; bytesRead: number } {
  if (buf.length < FRAME_HEADER_BYTES) {
    throw new FrameError(`need ${FRAME_HEADER_BYTES} header bytes, have ${buf.length}`)
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (view.getUint8(0) !== FRAME_MAGIC) {
    throw new FrameError(`bad magic 0x${view.getUint8(0).toString(16)}`)
  }
  const lenLo = view.getUint32(8, true)
  const lenHi = view.getUint32(12, true)
  const payloadLen = view.getUint32(16, true)
  const total = FRAME_HEADER_BYTES + payloadLen
  if (buf.length < total) {
    throw new FrameError(`frame wants ${total} bytes, have ${buf.length}`)
  }
  const frame: Frame = {
    op: view.getUint8(1) as OpCode,
    reply: (view.getUint8(2) & FLAG_REPLY) !== 0,
    bus: view.getUint8(3),
    select: view.getUint16(4, true),
    seq: view.getUint16(6, true),
    t: lenHi * 0x100000000 + lenLo,
    payload: buf.subarray(FRAME_HEADER_BYTES, total)
  }
  return { frame, bytesRead: total }
}

/**
 * Reassembles frames from a byte stream that can split anywhere — the socket
 * equivalent of `LineStreamer`. Feed it chunks, get back whole frames.
 */
export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0)

  push(chunk: Uint8Array): Frame[] {
    this.buffer = concat(this.buffer, chunk)
    const frames: Frame[] = []
    for (;;) {
      if (this.buffer.length < FRAME_HEADER_BYTES) break
      if (this.buffer[0] !== FRAME_MAGIC) {
        throw new FrameError(`bad magic 0x${(this.buffer[0] ?? 0).toString(16)} in stream`)
      }
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength)
      const total = FRAME_HEADER_BYTES + view.getUint32(16, true)
      if (this.buffer.length < total) break
      const { frame } = decodeFrame(this.buffer.subarray(0, total))
      // Copy the payload out so it does not alias the shifting buffer.
      frames.push({ ...frame, payload: frame.payload.slice() })
      this.buffer = this.buffer.subarray(total)
    }
    return frames
  }

  /** Bytes held back waiting for the rest of a frame. */
  get pending(): number {
    return this.buffer.length
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/**
 * FNV-1a of a signal name, truncated to 16 bits, so the C side can pass a
 * device's signal (`ANODE`, `KEY_INT`) through the fixed-width `select` field
 * without a string table. Collisions within one device's handful of signals
 * are checked at board-load time by the host.
 */
export function signalHash(name: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash & 0xffff
}
