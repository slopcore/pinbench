import {
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman
} from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { harness } from './harness'
import { buildMeshFrame, decodeMeshFrame, Lr1110Model, loraToaMs } from './lr1110'

type H = ReturnType<typeof harness>

/** A RadioLib write command: `[opHi, opLo, ...params]` in one NSS group. */
function write(h: H, op: number, ...params: number[]): void {
  h.bus({
    bus: 'spi0',
    kind: 'spi',
    select: 'NSS',
    mosi: Uint8Array.from([op >> 8, op & 0xff, ...params])
  })
}

/**
 * A RadioLib read command: the opcode write, then a bare-NOP transaction of
 * `replyLen + 1` zero bytes whose reply is `[Stat1, ...data]`.
 */
function read(h: H, op: number, args: number[], replyLen: number): Uint8Array {
  write(h, op, ...args)
  return h.bus({
    bus: 'spi0',
    kind: 'spi',
    select: 'NSS',
    mosi: new Uint8Array(replyLen + 1)
  })
}

/** SPIcheckStatus / getIrqStatus: a bare six-byte zero read. */
function poll(h: H): Uint8Array {
  return h.bus({ bus: 'spi0', kind: 'spi', select: 'NSS', mosi: new Uint8Array(6) })
}

/** RadioLib's SPIparseStatus, transcribed — the check every command passes. */
function parseStatus(stat1: number): 'ok' | 'perr' | 'fail' | 'not-found' {
  if ((stat1 & 0b1110) === 0x01 << 1) return 'perr'
  if ((stat1 & 0b1110) === 0x00 << 1) return 'fail'
  if (stat1 === 0x00 || stat1 === 0xff) return 'not-found'
  return 'ok'
}

const OP = {
  SET_STANDBY: 0x011c,
  SET_DIO_IRQ_PARAMS: 0x0113,
  CLEAR_IRQ: 0x0114,
  CALIBRATE: 0x010f,
  GET_VERSION: 0x0101,
  SET_PACKET_TYPE: 0x020e,
  SET_RF_FREQUENCY: 0x020b,
  SET_MODULATION_PARAMS: 0x020f,
  SET_TX_PARAMS: 0x0211,
  WRITE_BUFFER: 0x0109,
  SET_TX: 0x020a,
  SET_RX: 0x0209
}

describe('Lr1110Model', () => {
  it('comes up in standby with the lines released', () => {
    const h = harness(new Lr1110Model())
    const s = h.snapshot()
    expect(s['mode']).toBe('standby')
    expect(s['packetType']).toBe('LoRa')
    expect(h.line('BUSY')).toBe(0)
    expect(h.line('IRQ')).toBe(0)
    expect(h.diagnostics).toEqual([])
  })

  it('answers the GetVersion handshake so RadioLib findChip() succeeds', () => {
    const h = harness(new Lr1110Model())
    const miso = read(h, OP.GET_VERSION, [], 4)
    expect(parseStatus(miso[0]!)).toBe('ok')
    // [Stat1, hw, device, fwMajor, fwMinor] — device 0x01 == LR1110.
    expect(miso[2]).toBe(0x01)
  })

  it('a status poll after any command parses as CMD_OK', () => {
    const h = harness(new Lr1110Model())
    write(h, OP.SET_STANDBY, 0x00)
    expect(parseStatus(poll(h)[0]!)).toBe('ok')
  })

  it('walks the radio_init() opcode sequence into observable state', () => {
    const h = harness(new Lr1110Model())
    // The shape of LR11x0::modSetup + begin(): reset, version, standby,
    // config (fallback/irq/calibrate/packet-type), then the LoRa params.
    read(h, OP.GET_VERSION, [], 4)
    write(h, OP.SET_STANDBY, 0x00)
    write(h, OP.SET_DIO_IRQ_PARAMS, 0, 0, 0, 0, 0, 0, 0, 0)
    write(h, OP.CLEAR_IRQ, 0xff, 0xff, 0xff, 0xff)
    write(h, OP.CALIBRATE, 0x3f)
    write(h, OP.SET_PACKET_TYPE, 0x02) // LoRa
    write(h, OP.SET_MODULATION_PARAMS, 11, 0x05, 0x05, 0x00) // SF11, BW250, CR4/5
    write(h, OP.SET_RF_FREQUENCY, 0x37, 0x59, 0x8a, 0x00) // 0x37598A00 = 928.5 MHz-ish
    write(h, OP.SET_TX_PARAMS, 22 & 0xff, 0x04)

    const s = h.snapshot()
    expect(s['mode']).toBe('standby')
    expect(s['sf']).toBe(11)
    expect(s['bwHz']).toBe(250_000)
    expect(s['crDen']).toBe(5)
    expect(s['txPowerDbm']).toBe(22)
    expect(s['freqHz']).toBe(0x37598a00)
    expect(h.diagnostics.filter((d) => /unimplemented/i.test(d.message))).toEqual([])
  })

  it('raises a single named diagnostic for an unimplemented opcode', () => {
    const h = harness(new Lr1110Model())
    write(h, 0x8005) // BOOT_REBOOT — bootloader command, not on the LoRa path
    expect(h.diagnostics).toHaveLength(1)
    expect(h.diagnostics[0]!.severity).toBe('warn')
    expect(h.diagnostics[0]!.message).toMatch(/unimplemented command 0x8005/)
  })

  it('pulses DIO9/IRQ on TX-done and drops it on CLEAR_IRQ', () => {
    const h = harness(new Lr1110Model())
    write(h, OP.SET_PACKET_TYPE, 0x02)
    write(h, OP.SET_MODULATION_PARAMS, 9, 0x05, 0x05, 0x00)
    write(h, OP.SET_DIO_IRQ_PARAMS, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0)
    write(h, OP.WRITE_BUFFER, 1, 2, 3, 4, 5, 6, 7, 8)
    write(h, OP.SET_TX, 0, 0, 0)

    expect(h.line('IRQ')).toBe(1)
    const irqWord = (poll(h)[2]! << 24) | (poll(h)[3]! << 16) | (poll(h)[4]! << 8) | poll(h)[5]!
    expect(irqWord & (1 << 2)).toBeTruthy() // TX_DONE
    expect(h.meter('airtime')).toBeGreaterThan(0)

    write(h, OP.CLEAR_IRQ, 0xff, 0xff, 0xff, 0xff)
    expect(h.line('IRQ')).toBe(0)
  })

  it('hardware reset via NRESET returns to power-on state', () => {
    const h = harness(new Lr1110Model())
    write(h, OP.SET_RF_FREQUENCY, 0x37, 0x59, 0x8a, 0x00)
    expect(h.snapshot()['freqHz']).toBe(0x37598a00)
    h.signal('NRESET', 0)
    h.signal('NRESET', 1)
    const s = h.snapshot()
    expect(s['freqHz']).toBe(0)
    expect(s['resetCount']).toBe(1)
  })

  it('flags an NRESET pulse with no SPI command that follows (missing SPI.begin → -707)', () => {
    vi.useFakeTimers()
    try {
      const h = harness(new Lr1110Model({ noTrafficMs: 50 }))
      h.signal('NRESET', 0)
      h.signal('NRESET', 1)
      expect(h.diagnostics).toHaveLength(0) // not yet — the window is still open
      vi.advanceTimersByTime(60)
      expect(h.diagnostics).toHaveLength(1)
      expect(h.diagnostics[0]!.severity).toBe('error')
      expect(h.diagnostics[0]!.message).toMatch(/no SPI command/)
      expect(h.diagnostics[0]!.message).toMatch(/spi\.begin/)
      expect(h.diagnostics[0]!.message).toMatch(/-707/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays quiet when an SPI command follows the NRESET pulse', () => {
    vi.useFakeTimers()
    try {
      const h = harness(new Lr1110Model({ noTrafficMs: 50 }))
      h.signal('NRESET', 0)
      h.signal('NRESET', 1)
      write(h, OP.GET_VERSION)
      vi.advanceTimersByTime(200)
      expect(h.diagnostics).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Inspector config fields move the modulation state', () => {
    const h = harness(new Lr1110Model())
    h.command('setParam', { bw: 500, sf: 7, cr: 6, txPower: 14 })
    const s = h.snapshot()
    expect(s['bwHz']).toBe(500_000)
    expect(s['sf']).toBe(7)
    expect(s['crDen']).toBe(6)
    expect(s['txPowerDbm']).toBe(14)
  })

  // The live RadioLib path: ArduinoHal clocks each command one byte per SPI
  // transaction, so `onBus` is called once per byte inside an NSS-low..NSS-high
  // frame. The helpers above deliver whole buffers (the `onBusWhole` path);
  // these drive the byte-framed path the emulator actually exercises.
  describe('byte-framed SPI (NSS-framed, one byte per onBus)', () => {
    /** Clock `bytes` one at a time inside an NSS frame; return the concatenated reply. */
    function frame(h: H, bytes: number[]): Uint8Array {
      h.signal('NSS', 0)
      const out: number[] = []
      for (const b of bytes)
        out.push(...h.bus({ bus: 'spi0', kind: 'spi', mosi: Uint8Array.of(b) }))
      h.signal('NSS', 1)
      return Uint8Array.from(out)
    }

    it('GetVersion byte-by-byte gives the same reply as a whole-buffer read', () => {
      const whole = read(harness(new Lr1110Model()), OP.GET_VERSION, [], 4)

      const h = harness(new Lr1110Model())
      frame(h, [OP.GET_VERSION >> 8, OP.GET_VERSION & 0xff]) // the opcode write
      const framed = frame(h, [0, 0, 0, 0, 0]) // the all-zero read-back

      expect([...framed]).toEqual([...whole])
      expect(parseStatus(framed[0]!)).toBe('ok')
      expect(framed[2]).toBe(0x01) // device byte == LR1110
    })

    it('a byte-framed status/IRQ poll reports the real irq word, not the status fill', () => {
      const h = harness(new Lr1110Model())
      // Arm the DIO9 mask and drive RX-done via an injected frame.
      frame(h, [OP.SET_PACKET_TYPE >> 8, OP.SET_PACKET_TYPE & 0xff, 0x02])
      frame(h, [OP.SET_MODULATION_PARAMS >> 8, OP.SET_MODULATION_PARAMS & 0xff, 9, 0x05, 0x05, 0])
      frame(h, [
        OP.SET_DIO_IRQ_PARAMS >> 8,
        OP.SET_DIO_IRQ_PARAMS & 0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0,
        0,
        0,
        0
      ])
      h.command('inject', { kind: 'channel', text: 'hi', rssi: -70, snr: 8 })
      expect(h.line('IRQ')).toBe(1)

      // getIrqStatus: a bare six-byte zero frame → [Stat1, Stat2, irq31..0].
      const poll6 = frame(h, [0, 0, 0, 0, 0, 0])
      const irq = (poll6[2]! << 24) | (poll6[3]! << 16) | (poll6[4]! << 8) | poll6[5]!
      expect(irq & (1 << 3)).toBe(1 << 3) // RX_DONE, and no spurious high bits
      expect(irq).toBe(1 << 3)
    })

    it('a byte-framed write takes effect on the NSS rising edge', () => {
      const h = harness(new Lr1110Model())
      frame(h, [OP.SET_RF_FREQUENCY >> 8, OP.SET_RF_FREQUENCY & 0xff, 0x37, 0x59, 0x8a, 0x00])
      expect(h.snapshot()['freqHz']).toBe(0x37598a00)
    })

    it('an unimplemented byte-framed opcode still raises one named diagnostic', () => {
      const h = harness(new Lr1110Model())
      frame(h, [0x80, 0x05])
      expect(
        h.diagnostics.filter((d) => /unimplemented command 0x8005/.test(d.message))
      ).toHaveLength(1)
    })
  })

  describe('IN-panel injection (M7.3)', () => {
    function configured(): ReturnType<typeof harness> {
      const h = harness(new Lr1110Model())
      write(h, OP.SET_PACKET_TYPE, 0x02)
      write(h, OP.SET_MODULATION_PARAMS, 11, 0x05, 0x05, 0x00) // SF11 BW250 CR4/5
      write(h, OP.SET_DIO_IRQ_PARAMS, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0)
      write(h, OP.SET_RX, 0, 0, 0)
      return h
    }

    it('a channel message raises RX-done, pulses DIO9, and fills the RX buffer', () => {
      const h = configured()
      h.command('inject', { kind: 'channel', text: 'trailhead in 20', rssi: -74, snr: 9 })
      expect(h.line('IRQ')).toBe(1)
      const irq = (poll(h)[2]! << 24) | (poll(h)[3]! << 16) | (poll(h)[4]! << 8) | poll(h)[5]!
      expect(irq & (1 << 3)).toBeTruthy() // RX_DONE
      const s = h.snapshot()
      expect(s['rxCount']).toBe(1)
      expect(s['lastRssi']).toBe(-74)
      expect(s['lastSnr']).toBe(9)
      expect(s['lastAirtimeMs']).toBeGreaterThan(0)
      // GET_RX_BUFFER_STATUS reports a non-zero payload length.
      expect(read(h, 0x0203, [], 2)[1]).toBeGreaterThan(0)
      // READ_BUFFER returns the injected bytes. Header 0x15 = MeshCore
      // ROUTE_TYPE_FLOOD | PAYLOAD_TYPE_GRP_TXT<<2 (a group text message).
      const status = read(h, 0x0203, [], 2)
      const len = status[1]!
      expect(read(h, 0x010a, [0, len], len)[1]).toBe(0x15)
    })

    it('a direct message fills the RX buffer with a type-0x02 (TXT_MSG) frame', () => {
      const h = configured()
      h.command('inject', { kind: 'direct', text: 'meet at the ridge', rssi: -66, snr: 8 })
      expect(h.line('IRQ')).toBe(1)
      const s = h.snapshot()
      expect(s['rxCount']).toBe(1)
      expect(s['lastRssi']).toBe(-66)
      const status = read(h, 0x0203, [], 2)
      const len = status[1]!
      const buf = read(h, 0x010a, [0, len], len)
      // Header 0x09 = ROUTE_TYPE_FLOOD | PAYLOAD_TYPE_TXT_MSG<<2; distinct from
      // the 0x15 group-text header. Payload starts [dest_hash][src_hash]; with no
      // `guestPub` the frame is the non-decodable placeholder — dest_hash 0x00.
      expect(buf[1]).toBe(0x09)
      expect(buf[3]).toBe(0x00)
    })

    it('an advert and an ack each raise RX-done with the right RSSI', () => {
      const h = configured()
      h.command('inject', { kind: 'advert', from: 0x11223344, hops: 3, rssi: -88 })
      expect(h.snapshot()['lastRssi']).toBe(-88)
      write(h, OP.CLEAR_IRQ, 0xff, 0xff, 0xff, 0xff)
      h.command('inject', { kind: 'ack', rssi: -60 })
      expect(h.line('IRQ')).toBe(1)
      expect(h.snapshot()['rxCount']).toBe(2)
    })

    it('a noise burst moves the floor without raising an IRQ', () => {
      const h = configured()
      h.command('inject', { kind: 'noise', floor: -95 })
      expect(h.line('IRQ')).toBe(0)
      const s = h.snapshot()
      expect(s['noiseFloorDbm']).toBe(-95)
      expect(s['rxCount']).toBe(0)
    })

    it('the airtime meter tracks the active modulation for an injected frame', () => {
      const h = configured()
      h.command('inject', { kind: 'channel', text: 'x'.repeat(40) })
      const slow = h.meter('airtime')!
      h.command('setParam', { sf: 7 })
      h.command('inject', { kind: 'channel', text: 'x'.repeat(40) })
      expect(h.meter('airtime')!).toBeLessThan(slow) // SF7 is faster than SF11
    })
  })
})

describe('buildMeshFrame — Public channel GRP_TXT', () => {
  // MeshCore's built-in Public group PSK (companion_radio MyMesh.cpp).
  const PSK = Buffer.from('izOH6cXN6mrJ5e26oRXNcg==', 'base64')

  /** BaseChatMesh::onGroupDataRecv, transcribed: MAC-check then AES-128-ECB. */
  function decodeChannel(frame: Uint8Array): { hash: number; text: string; ts: number } {
    expect(frame[0]).toBe(0x15) // FLOOD | GRP_TXT<<2
    expect(frame[1]).toBe(0x00) // path_len
    const payload = Buffer.from(frame.slice(2))
    const hash = payload[0]!
    const mac = payload.subarray(1, 3)
    const ciphertext = payload.subarray(3)

    const hmacKey = Buffer.concat([PSK, Buffer.alloc(16)])
    const want = createHmac('sha256', hmacKey).update(ciphertext).digest().subarray(0, 2)
    expect(Buffer.compare(mac, want)).toBe(0)

    const aes = createDecipheriv('aes-128-ecb', PSK, null)
    aes.setAutoPadding(false)
    const plain = Buffer.concat([aes.update(ciphertext), aes.final()])
    expect(plain[4]).toBe(0) // TXT_TYPE_PLAIN, (>>2)==0
    const nul = plain.indexOf(0, 5)
    return {
      hash,
      ts: plain.readUInt32LE(0),
      text: plain.toString('utf8', 5, nul === -1 ? plain.length : nul)
    }
  }

  it('round-trips through the guest decrypt path with the sender prefix', () => {
    const frame = buildMeshFrame('channel', { text: 'trailhead in 20', timestamp: 1_724_400_000 })
    const got = decodeChannel(frame)
    expect(got.hash).toBe(createHash('sha256').update(PSK).digest()[0])
    expect(got.text).toBe('pinbench: trailhead in 20')
    expect(got.ts).toBe(1_724_400_000)
  })

  it('honours an explicit sender name and pads to a whole AES block', () => {
    const frame = buildMeshFrame('channel', { text: 'hi', sender: 'basecamp', timestamp: 1 })
    expect((frame.length - 5) % 16).toBe(0) // payload minus [hdr][plen][hash][mac2]
    expect(decodeChannel(frame).text).toBe('basecamp: hi')
  })
})

describe('decodeMeshFrame — the wire → plaintext (radio OUT panel)', () => {
  it('round-trips a Public-channel GRP_TXT built by buildMeshFrame', () => {
    const frame = buildMeshFrame('channel', {
      text: 'tx probe',
      sender: 'M9',
      timestamp: 1_724_400_000
    })
    const got = decodeMeshFrame(frame)
    expect(got).not.toBeNull()
    expect(got!.kind).toBe('channel')
    expect(got!.text).toBe('M9: tx probe')
    expect(got!.ts).toBe(1_724_400_000)
  })

  it('reads a frame a flood relay has re-stamped with a non-zero path', () => {
    const frame = buildMeshFrame('channel', { text: 'relayed', sender: 'x', timestamp: 1 })
    // A relay inserts path_len hash bytes after the header and bumps path_len.
    const relayed = Uint8Array.from([frame[0]!, 0x02, 0xaa, 0xbb, ...frame.slice(2)])
    expect(decodeMeshFrame(relayed)?.text).toBe('x: relayed')
  })

  it('returns null for a direct TXT_MSG, an advert, and a runt', () => {
    expect(decodeMeshFrame(buildMeshFrame('direct', { text: 'secret' }))).toBeNull()
    expect(decodeMeshFrame(buildMeshFrame('advert', { hops: 1 }))).toBeNull()
    expect(decodeMeshFrame(Uint8Array.from([0x15, 0x00]))).toBeNull()
  })

  it('returns null when the MAC does not verify (wrong channel / corruption)', () => {
    const frame = Buffer.from(buildMeshFrame('channel', { text: 'hi', timestamp: 1 }))
    frame[frame.length - 1] = frame[frame.length - 1]! ^ 0xff // flip a ciphertext byte
    expect(decodeMeshFrame(frame)).toBeNull()
  })
})

describe('buildMeshFrame — direct TXT_MSG', () => {
  // MeshCore's own key-exchange self-test vector (src/Identity.cpp
  // LocalIdentity::validatePrivateKey): a known-good orlp/ed25519 keypair.
  const TEST_CLIENT_PRV = Buffer.from(
    '7065e18fd9fabb70c1ed90dca19907de698c88b709ea146eafd93d9b830c7b60' +
      'c4681193c79bbc39945ba8064104bb618f8fd7a84a0af6f57033d6e8ddcd6471',
    'hex'
  )
  const TEST_CLIENT_PUB = Buffer.from(
    '1ec77175b0918ed206f9ae04ec136d6d5d4315bb26305427f645b492e9350c10',
    'hex'
  )

  const P = (1n << 255n) - 19n
  const mod = (a: bigint): bigint => ((a % P) + P) % P
  const pow = (b: bigint, e: bigint): bigint => {
    let r = 1n
    let x = mod(b)
    let n = e
    while (n > 0n) {
      if (n & 1n) r = mod(r * x)
      x = mod(x * x)
      n >>= 1n
    }
    return r
  }
  const leToBig = (buf: Uint8Array): bigint => {
    let x = 0n
    for (let i = buf.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(buf[i]!)
    return x
  }
  const bigToLe = (x: bigint): Buffer => {
    const b = Buffer.alloc(32)
    let v = x
    for (let i = 0; i < 32; i++) {
      b[i] = Number(v & 0xffn)
      v >>= 8n
    }
    return b
  }
  const montU = (edPub: Buffer): Buffer => {
    const y = mod(leToBig(edPub) & ((1n << 255n) - 1n))
    return bigToLe(mod((1n + y) * pow(mod(1n - y), P - 2n)))
  }
  const x25519 = (scalar: Buffer, u: Buffer): Buffer =>
    diffieHellman({
      privateKey: createPrivateKey({
        key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), scalar]),
        format: 'der',
        type: 'pkcs8'
      }),
      publicKey: createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), u]),
        format: 'der',
        type: 'spki'
      })
    })

  it('reproduces MeshCore ed25519_key_exchange symmetry (its own self-test)', () => {
    // A second keypair: the synthetic sender the module uses.
    const seed = createHash('sha256').update('pinbench-lora-direct-sender/v1').digest()
    const edPrv = createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
      format: 'der',
      type: 'pkcs8'
    })
    const senderPub = Buffer.from(
      (createPublicKey(edPrv).export({ format: 'jwk' }) as { x: string }).x,
      'base64url'
    )
    const h = createHash('sha512').update(seed).digest()
    h[0]! &= 248
    h[31]! &= 63
    h[31]! |= 64
    const senderScalar = h.subarray(0, 32)

    // ss1: our scalar × test-client point.  ss2: test-client scalar × our point.
    const ss1 = x25519(senderScalar, montU(TEST_CLIENT_PUB))
    const ss2 = x25519(TEST_CLIENT_PRV.subarray(0, 32), montU(senderPub))
    expect(Buffer.compare(ss1, ss2)).toBe(0)
    expect(ss1.every((b) => b === 0)).toBe(false)
  })

  it('emits a type-0x09 frame the recipient can MAC-then-decrypt', () => {
    const guestPub = TEST_CLIENT_PUB.toString('hex')
    const frame = Buffer.from(
      buildMeshFrame('direct', { text: 'meet at the ridge', guestPub, timestamp: 1_724_400_000 })
    )
    expect(frame[0]).toBe(0x09) // FLOOD | TXT_MSG<<2
    expect(frame[1]).toBe(0x00)
    expect(frame[2]).toBe(TEST_CLIENT_PUB[0]) // dest_hash = guestPub[0]

    // Recreate the guest's shared secret: X25519(guest_scalar, montU(senderPub)).
    const src = buildMeshFrame('pair', { sender: 'x', timestamp: 1 })
    const senderPub = Buffer.from(src.slice(2, 34))
    expect(frame[3]).toBe(senderPub[0]) // src_hash

    const secret = x25519(TEST_CLIENT_PRV.subarray(0, 32), montU(senderPub))
    const ciphertext = frame.subarray(6)
    const mac = createHmac('sha256', secret).update(ciphertext).digest().subarray(0, 2)
    expect(Buffer.compare(frame.subarray(4, 6), mac)).toBe(0)

    const aes = createDecipheriv('aes-128-ecb', secret.subarray(0, 16), null)
    aes.setAutoPadding(false)
    const plain = Buffer.concat([aes.update(ciphertext), aes.final()])
    expect(plain.readUInt32LE(0)).toBe(1_724_400_000)
    expect(plain[4]! >> 2).toBe(0) // TXT_TYPE_PLAIN
    const nul = plain.indexOf(0, 5)
    expect(plain.toString('utf8', 5, nul === -1 ? plain.length : nul)).toBe('meet at the ridge')
  })

  it('without guestPub, emits a non-decodable placeholder (host fills the key)', () => {
    const frame = Buffer.from(buildMeshFrame('direct', { text: 'hi' }))
    expect(frame[0]).toBe(0x09) // still a TXT_MSG-shaped frame
    expect(frame[2]).toBe(0x00) // dest_hash 0x00 — decrypts nowhere
    // src_hash is still the synthetic sender, and there is no real MAC.
    const paired = buildMeshFrame('pair', { sender: 'x', timestamp: 1 })
    expect(frame[3]).toBe(paired[2])
  })
})

describe('loraToaMs', () => {
  it('matches the Semtech airtime formula for a known point', () => {
    // SF7, BW125 kHz, CR4/5, 20-byte payload ≈ 56 ms (LoRa calculator).
    const toa = loraToaMs(7, 125_000, 5, 20)
    expect(toa).toBeGreaterThan(45)
    expect(toa).toBeLessThan(75)
  })

  it('grows with spreading factor', () => {
    expect(loraToaMs(11, 250_000, 5, 32)).toBeGreaterThan(loraToaMs(7, 250_000, 5, 32))
  })
})
