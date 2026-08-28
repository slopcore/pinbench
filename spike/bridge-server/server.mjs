/*
 * PinBench M0 spike - Node-hosted device model behind a Unix socket.
 *
 * Implements the same trivial "display-like" byte sink as the C model in
 * hw/misc/pinbench_bench.c. If the checksums the harness reports do not match
 * between the native and bridged modes, the two implementations have drifted
 * and the measurement is meaningless - so the checksum is the test.
 *
 * Wire protocol: [op:u8][len:u32 LE][payload:len].
 *   0x01 XFER  len=1  -> 1 byte
 *   0x02 BURST len=n  -> n bytes
 *   0x03 CS    len=2  -> 1 byte ack
 *   0x04 PING  len=0  -> 1 byte ack
 *   0x05 RESET len=0  -> 1 byte ack
 */
import net from 'node:net';
import fs from 'node:fs';

const SOCKET = process.argv[2] ?? '/tmp/pinbench-bridge.sock';
const FB_BYTES = 320 * 240 * 2;

const OP = { XFER: 0x01, BURST: 0x02, CS: 0x03, PING: 0x04, RESET: 0x05 };

class PixelSink {
  constructor() {
    this.fb = Buffer.alloc(FB_BYTES);
    this.cursor = 0;
  }

  reset() {
    this.fb.fill(0);
    this.cursor = 0;
  }

  byte(tx) {
    const rx = this.fb[this.cursor];
    this.fb[this.cursor] = tx;
    this.cursor = this.cursor + 1 === FB_BYTES ? 0 : this.cursor + 1;
    return rx;
  }

  // Same result as calling byte() len times, without the per-byte overhead.
  bulk(tx, rx) {
    let done = 0;
    while (done < tx.length) {
      const chunk = Math.min(tx.length - done, FB_BYTES - this.cursor);
      this.fb.copy(rx, done, this.cursor, this.cursor + chunk);
      tx.copy(this.fb, this.cursor, done, done + chunk);
      this.cursor += chunk;
      if (this.cursor === FB_BYTES) this.cursor = 0;
      done += chunk;
    }
    return rx;
  }
}

function handle(sock) {
  sock.setNoDelay(true);
  const sink = new PixelSink();

  // Hand-rolled framing. A stream socket can split anywhere, so buffer until
  // a whole frame is present; anything less and the throughput numbers would
  // be measuring a bug.
  let buf = Buffer.alloc(0);

  sock.on('data', (chunk) => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);

    for (;;) {
      if (buf.length < 5) return;
      const op = buf[0];
      const len = buf.readUInt32LE(1);
      if (buf.length < 5 + len) return;
      const payload = buf.subarray(5, 5 + len);

      switch (op) {
        case OP.XFER:
          sock.write(Buffer.from([sink.byte(payload[0])]));
          break;
        case OP.BURST:
          sock.write(sink.bulk(payload, Buffer.allocUnsafe(len)));
          break;
        case OP.CS:
          sock.write(Buffer.from([0]));
          break;
        case OP.PING:
          sock.write(Buffer.from([0x5a]));
          break;
        case OP.RESET:
          sink.reset();
          sock.write(Buffer.from([0]));
          break;
        default:
          console.error(`pinbench-host: unknown op 0x${op.toString(16)}`);
          sock.destroy();
          return;
      }

      buf = buf.subarray(5 + len);
    }
  });

  sock.on('error', (e) => console.error('pinbench-host: socket error', e.message));
}

try { fs.unlinkSync(SOCKET); } catch { /* not there, fine */ }

const server = net.createServer(handle);
server.listen(SOCKET, () => console.log(`pinbench-host: listening on ${SOCKET}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    try { fs.unlinkSync(SOCKET); } catch { /* already gone */ }
    process.exit(0);
  });
}
