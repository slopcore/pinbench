import { describe, expect, it, vi } from 'vitest'
import { probeCompanionIdentity, type CompanionProbeDeps } from './mesh-companion'

/** A fake advert `tx` payload: [header 0x12][path_len 0][pub(32)][ts(4)][sig(64)]. */
function advertHex(pub: string): string {
  const pubBytes = Buffer.from(pub, 'hex')
  const body = Buffer.concat([pubBytes, Buffer.alloc(4 + 64)])
  return Buffer.concat([Buffer.from([0x12, 0x00]), body]).toString('hex')
}

const PUB = 'a'.repeat(64)

describe('probeCompanionIdentity', () => {
  it('triggers a self-advert and returns the pub key from the radio TX', async () => {
    let emit: (
      msg: Parameters<Parameters<CompanionProbeDeps['onDeviceEvent']>[0]>[0]
    ) => void = () => {}
    const deps: CompanionProbeDeps = {
      writeSerialBytes: vi.fn((bytes) => {
        // The one trigger frame: CMD_SEND_SELF_ADVERT, zero-hop, 0x01-free.
        expect([...bytes]).toEqual([0x3c, 0x02, 0x00, 0x07, 0x00])
        // Guest answers on the modelled radio a moment later.
        queueMicrotask(() =>
          emit({ partId: 'u2', event: { kind: 'tx', detail: { payloadHex: advertHex(PUB) } } })
        )
      }),
      onDeviceEvent: (listener) => {
        emit = listener
        return () => {}
      }
    }
    await expect(probeCompanionIdentity(deps, { attempts: 3, attemptGapMs: 50 })).resolves.toBe(PUB)
    expect(deps.writeSerialBytes).toHaveBeenCalledTimes(1)
  })

  it('ignores non-advert TX and gives up after the attempt budget', async () => {
    const deps: CompanionProbeDeps = {
      writeSerialBytes: vi.fn(),
      onDeviceEvent: (listener) => {
        // A plain data TX (header type != ADVERT) must not resolve it.
        listener({
          partId: 'u2',
          event: { kind: 'tx', detail: { payloadHex: '09' + '00'.repeat(120) } }
        })
        return () => {}
      }
    }
    await expect(
      probeCompanionIdentity(deps, { attempts: 2, attemptGapMs: 10 })
    ).resolves.toBeNull()
    expect(deps.writeSerialBytes).toHaveBeenCalledTimes(2)
  })
})
