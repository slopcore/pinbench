/*
 * PinBench M4 — measure the device-host wire protocol's framing overhead.
 *
 * ADR 0001 open question 3: "Framing overhead is not measured. The spike moved
 * raw bytes with a 5-byte header. Real traffic carries a device id, a bus id,
 * and probably a timestamp. Measure it in M4 once the real protocol exists."
 *
 * This measures two things:
 *   1. encode + decode CPU cost per frame, for the 153,600-byte display flush
 *      and for a 1-byte transaction — how much the 20-byte header and the
 *      DataView work add on top of the raw copy.
 *   2. A real Unix-domain-socket round trip on THIS host, which is the number
 *      ADR open question 1 wants re-measured on macOS. Batching amortises
 *      whatever this costs; the per-transaction budget in the ADR does not.
 *
 *   node scripts/bench-framing.mjs
 *
 * Prints a Markdown table for pasting into docs/adr/0001-device-model-boundary.md.
 */

import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

// Keep this in lockstep with src/shared/devices/protocol.ts. The bench is
// deliberately a standalone re-implementation so it measures the wire format,
// not an import graph.
const HEADER = 20
const MAGIC = 0x9b
const OP_XFER = 0x02

function encode(op, seq, t, payload) {
  const out = Buffer.allocUnsafe(HEADER + payload.length)
  out[0] = MAGIC
  out[1] = op
  out[2] = 0
  out[3] = 0
  out.writeUInt16LE(0xffff, 4)
  out.writeUInt16LE(seq & 0xffff, 6)
  out.writeUInt32LE(t >>> 0, 8)
  out.writeUInt32LE(Math.floor(t / 0x100000000) >>> 0, 12)
  out.writeUInt32LE(payload.length, 16)
  payload.copy(out, HEADER)
  return out
}

function decode(buf) {
  if (buf[0] !== MAGIC) throw new Error('bad magic')
  const len = buf.readUInt32LE(16)
  return {
    op: buf[1],
    seq: buf.readUInt16LE(6),
    t: buf.readUInt32LE(12) * 0x100000000 + buf.readUInt32LE(8),
    payload: buf.subarray(HEADER, HEADER + len)
  }
}

function timeCodec(label, payloadLen, iterations) {
  const payload = Buffer.alloc(payloadLen, 0xa5)
  // warm up
  for (let i = 0; i < 1000; i++) decode(encode(OP_XFER, i, i, payload))

  const start = performance.now()
  let checksum = 0
  for (let i = 0; i < iterations; i++) {
    const frame = decode(encode(OP_XFER, i, i * 1_000_000, payload))
    checksum ^= frame.payload[0] ^ frame.payload[frame.payload.length - 1]
  }
  const ms = performance.now() - start
  const nsPerFrame = (ms * 1e6) / iterations
  return {
    label,
    payloadLen,
    nsPerFrame,
    mibPerSec: payloadLen === 0 ? 0 : payloadLen / 1048576 / (nsPerFrame / 1e9),
    headerPctOfFrame: (HEADER / (HEADER + payloadLen)) * 100,
    checksum
  }
}

function socketRoundTrip(iterations) {
  return new Promise((resolve, reject) => {
    const sockPath = path.join(os.tmpdir(), `pinbench-bench-${process.pid}.sock`)
    const server = net.createServer((sock) => {
      sock.setNoDelay(true)
      // Echo one header's worth back per frame — the host's reply is a frame too.
      let buf = Buffer.alloc(0)
      sock.on('data', (chunk) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
        while (buf.length >= HEADER) {
          const total = HEADER + buf.readUInt32LE(16)
          if (buf.length < total) break
          sock.write(encode(OP_XFER, buf.readUInt16LE(6), 0, Buffer.alloc(1)))
          buf = buf.subarray(total)
        }
      })
    })
    server.listen(sockPath, () => {
      const client = net.createConnection(sockPath)
      client.setNoDelay(true)
      const oneByte = Buffer.alloc(1)
      let done = 0
      let start = 0
      client.on('connect', () => {
        start = performance.now()
        client.write(encode(OP_XFER, done, 0, oneByte))
      })
      let rbuf = Buffer.alloc(0)
      client.on('data', (chunk) => {
        rbuf = rbuf.length ? Buffer.concat([rbuf, chunk]) : chunk
        while (rbuf.length >= HEADER) {
          const total = HEADER + rbuf.readUInt32LE(16)
          if (rbuf.length < total) break
          rbuf = rbuf.subarray(total)
          done++
          if (done >= iterations) {
            const ns = ((performance.now() - start) * 1e6) / iterations
            client.end()
            server.close(() => resolve(ns))
            return
          }
          client.write(encode(OP_XFER, done, 0, oneByte))
        }
      })
      client.on('error', reject)
    })
  })
}

const FRAME = 320 * 240 * 2

const rows = [
  timeCodec('1-byte transaction', 1, 2_000_000),
  timeCodec('full 153,600-byte frame', FRAME, 20_000)
]

const rtNs = await socketRoundTrip(20_000)

console.log(`\nHost: ${os.type()} ${os.release()} ${os.arch()}, Node ${process.version}\n`)

console.log('| Payload | Header share of bytes | encode+decode | throughput |')
console.log('|---|---|---|---|')
for (const r of rows) {
  const rate = r.payloadLen === 0 ? '—' : `${r.mibPerSec.toFixed(0)} MiB/s`
  console.log(
    `| ${r.label} | ${r.headerPctOfFrame.toFixed(r.payloadLen === 1 ? 1 : 3)}% | ` +
      `${r.nsPerFrame.toFixed(0)} ns | ${rate} |`
  )
}
console.log(`\nUnix-socket round trip on this host: ${(rtNs / 1000).toFixed(1)} µs/transaction`)
console.log(
  `(spike measured ~48–64 µs on Linux; the batching conclusion is independent of this number)\n`
)
