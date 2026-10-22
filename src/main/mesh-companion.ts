/**
 * Learn the identity key of a booted MeshCore companion guest, so an injected
 * `direct` message can be encrypted for it without a hard-coded key.
 *
 * The guest's own signed advert carries its public key
 * (`[header][path_len][pub_key(32)][ts(4)][sig(64)][app_data]`,
 * `Mesh::createAdvert`). A companion node never adverts unprompted, but the
 * `CMD_SEND_SELF_ADVERT` (0x07) command over the UART0 app protocol makes it
 * broadcast one on the modelled radio — where the SX1262 model exposes the TX
 * payload as a `tx` event. So this never has to parse the guest's binary reply
 * off the console: it writes one 0x01-free command frame and watches the radio.
 */

/** app→node companion frame `'<' len_lo len_hi payload`; `CMD_SEND_SELF_ADVERT`, zero-hop. */
const SEND_SELF_ADVERT_FRAME = Uint8Array.from([0x3c, 0x02, 0x00, 0x07, 0x00])

const ADVERT_PAYLOAD_TYPE = 0x04 // PH_TYPE, MeshCore Packet.h
const MIN_ADVERT_LEN = 2 + 32 + 4 + 64 // header+path_len, pub_key, timestamp, signature

export interface CompanionProbeDeps {
  /** Write raw bytes to the guest's UART0 (no newline). */
  writeSerialBytes(bytes: Uint8Array): void
  /** Subscribe to device-model events; returns an unsubscribe function. */
  onDeviceEvent(
    listener: (msg: {
      partId: string
      event: { kind: string; detail?: Record<string, unknown> }
    }) => void
  ): () => void
}

export interface CompanionProbeOptions {
  /** How many times to (re)send the trigger before giving up. Default 10. */
  attempts?: number
  /** Gap between trigger sends. Default 2000 ms. */
  attemptGapMs?: number
}

/**
 * Returns the guest's 32-byte identity key as hex, or `null` if no advert is
 * seen within `attempts × attemptGapMs` (not a companion image, `_ble` variant
 * with no UART protocol, emulator not running, …).
 */
export function probeCompanionIdentity(
  deps: CompanionProbeDeps,
  options: CompanionProbeOptions = {}
): Promise<string | null> {
  const attempts = options.attempts ?? 10
  const gapMs = options.attemptGapMs ?? 2000

  return new Promise((resolve) => {
    let settled = false
    let sends = 0

    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      unsubscribe()
      clearInterval(timer)
      resolve(value)
    }

    const unsubscribe = deps.onDeviceEvent((msg) => {
      if (settled || msg.event.kind !== 'tx') return
      const hex = msg.event.detail?.['payloadHex']
      if (typeof hex !== 'string' || hex.length < MIN_ADVERT_LEN * 2) return
      const bytes = Buffer.from(hex, 'hex')
      if (((bytes[0]! >> 2) & 0x0f) !== ADVERT_PAYLOAD_TYPE) return
      finish(bytes.subarray(2, 34).toString('hex'))
    })

    const tick = (): void => {
      if (settled) return
      if (sends++ >= attempts) {
        finish(null)
        return
      }
      deps.writeSerialBytes(SEND_SELF_ADVERT_FRAME)
    }

    tick()
    const timer = setInterval(tick, gapMs)
  })
}
