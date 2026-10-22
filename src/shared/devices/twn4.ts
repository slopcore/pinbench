/**
 * Elatec TWN4 MultiTech 3 (order code T43O-F6C0) — the LF + HF RFID/NFC OEM
 * reader in the Waveshare ESP32-S3-ETH kit, on UART1 at TTL level.
 *
 * ## What is on the wire
 *
 * What a TWN4 sends depends on the app flashed into it, so the model speaks
 * the two a host is most likely to meet, picked by `deviceOptions.protocol`:
 *
 *   - `simple` (default): Elatec's **Simple Protocol** in ASCII mode — the
 *     host sends one API call as hex + CR, the reader answers hex + CR. Every
 *     reply starts with a status byte (`00` ok, `01` unknown function, `02`
 *     missing parameter, `03` unused parameters, `05` parser error), then the
 *     function's results. Arrays travel length-prefixed. The common calls:
 *
 *       `0004 LL`            GetVersionString(MaxLen) → `00 LL "TWN4 …"`
 *       `0500 MM`            SearchTag(MaxIDBytes)    → `00 00` none, or
 *                                                       `00 01 TT BB LL ID…`
 *       `0501`               SetRFOff
 *       `0502 LF×4 HF×4`     SetTagTypes (little-endian masks)
 *       `0503` / `0504`      Get(Supported)TagTypes   → `00 LF×4 HF×4`
 *       `0407 VV FFFF NNNN OOOO`  Beep(volume, Hz, on ms, off ms)
 *       `0400`–`040B`        GPIO / diag LED (GPIO0 red, GPIO1 green, …)
 *
 *   - `id`: a keyboard-wedge style app that, on each new card, prints the ID
 *     as upper-case hex + CR and never reads anything back.
 *
 * Anything else raises a named diagnostic and answers status `01`, per the
 * "unimplemented commands are loud" rule.
 *
 * ## Cards
 *
 * The IN panel `present`s a card (`uid` hex, `type` name or code) and
 * `remove`s it. A present card is found by every SearchTag while its type is
 * enabled by SetTagTypes and the field is on — the silicon re-reads a tag
 * that stays in the field.
 */

import type {
  DeviceContext,
  DeviceModel,
  DeviceModelDescriptor,
  DeviceSnapshot,
  MeterDeclaration
} from './model'

/** Tag-type codes, as the TWN4 API's `LFTAG_*` / `HFTAG_*`. */
export const TWN4_TAG_TYPES: Record<string, number> = {
  em4102: 0x40,
  hitag1s: 0x41,
  hitag2: 0x42,
  em4150: 0x43,
  at5555: 0x44,
  isofdx: 0x45,
  em4026: 0x46,
  hitagu: 0x47,
  em4305: 0x48,
  hidprox: 0x49,
  tiris: 0x4a,
  cotag: 0x4b,
  ioprox: 0x4c,
  indala: 0x4d,
  awid: 0x4f,
  mifare: 0x80,
  iso14443b: 0x81,
  iso15693: 0x82,
  legic: 0x83,
  hidiclass: 0x84,
  felica: 0x85,
  srx: 0x86,
  nfcp2p: 0x87,
  ble: 0x88,
  topaz: 0x89
}

const ERR_NONE = 0
const ERR_UNKNOWN_FUNCTION = 1
const ERR_MISSING_PARAMETER = 2
const ERR_UNUSED_PARAMETERS = 3
const ERR_PARSER = 5

/** LF types are 0x40.., HF 0x80..; a mask bit is `type & 0x1f`. */
const SUPPORTED_LF = 0x07ffffff
const SUPPORTED_HF = 0x00000fff

export const TWN4_VERSION = 'TWN4/B1.10/NCF4.06/PRS1.04' // shape of a real banner

const LED_NAMES = ['red', 'green', 'yellow'] as const

export type Twn4Protocol = 'simple' | 'id'

export interface Twn4Options {
  protocol?: Twn4Protocol
}

interface Card {
  type: number
  uid: Uint8Array
}

/** Little-endian 32-bit read, for the tag-type masks. */
function u32(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0
  )
}

function u32Bytes(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
}

function hex(bytes: ArrayLike<number>): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++)
    out += bytes[i]!.toString(16).toUpperCase().padStart(2, '0')
  return out
}

export function tagTypeCode(raw: unknown): number | null {
  if (typeof raw === 'number' && raw >= 0x40 && raw <= 0x9f) return raw
  if (typeof raw === 'string') {
    const key = raw.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (key in TWN4_TAG_TYPES) return TWN4_TAG_TYPES[key]!
  }
  return null
}

export function tagTypeName(code: number): string {
  return Object.entries(TWN4_TAG_TYPES).find(([, c]) => c === code)?.[0] ?? `0x${code.toString(16)}`
}

function isLf(type: number): boolean {
  return type < 0x80
}

/** The `(arguments) → expected byte count` table for fixed-shape calls. */
const ARG_BYTES: Record<number, number> = {
  0x0001: 0, // Reset
  0x0003: 0, // GetSysTicks
  0x0004: 1, // GetVersionString(MaxLen)
  0x0005: 0, // GetUSBType
  0x0006: 0, // GetDeviceType
  0x0400: 3, // GPIOConfigureOutputs(Bits, PullUpDown, OutputType)
  0x0401: 2, // GPIOConfigureInputs(Bits, PullUpDown)
  0x0402: 1, // GPIOSetBits
  0x0403: 1, // GPIOClearBits
  0x0404: 1, // GPIOToggleBits
  0x0405: 5, // GPIOBlinkBits(Bits, TimeHi, TimeLo)
  0x0406: 1, // GPIOTestBit
  0x0407: 7, // Beep(Volume, Frequency, OnTime, OffTime)
  0x0408: 0, // DiagLEDOn
  0x0409: 0, // DiagLEDOff
  0x040a: 0, // DiagLEDToggle
  0x040b: 0, // DiagLEDIsOn
  0x0500: 1, // SearchTag(MaxIDBytes)
  0x0501: 0, // SetRFOff
  0x0502: 8, // SetTagTypes(LF, HF)
  0x0503: 0, // GetTagTypes
  0x0504: 0 // GetSupportedTagTypes
}

const USB_TYPE_NONE = 0
const DEVICE_TYPE_MULTITECH3 = 0x0c

export class Twn4Model implements DeviceModel {
  readonly id = 'elatec.twn4'
  readonly meters: readonly MeterDeclaration[] = [
    { id: 'commands', label: 'Commands' },
    { id: 'reads', label: 'Card reads' },
    { id: 'beeps', label: 'Beeps' }
  ]

  private protocol: Twn4Protocol
  private ctx: DeviceContext | null = null
  private line: number[] = []
  private card: Card | null = null
  private lfMask = SUPPORTED_LF
  private hfMask = SUPPORTED_HF
  private rfOn = false
  /** Output bits driven by the GPIO API; bit 0 red LED, bit 1 green, bit 2 yellow. */
  private gpioOut = 0
  private diagLed = false
  private commands = 0
  private reads = 0
  private beeps = 0
  private lastCommand = ''
  private lastReply = ''
  private bootMs = Date.now()

  constructor(options: Twn4Options = {}) {
    this.protocol = options.protocol ?? 'simple'
  }

  attach(ctx: DeviceContext): void {
    this.ctx = ctx
  }

  reset(): void {
    this.line = []
    this.lfMask = SUPPORTED_LF
    this.hfMask = SUPPORTED_HF
    this.rfOn = false
    this.gpioOut = 0
    this.diagLed = false
    this.bootMs = Date.now()
  }

  detach(): void {
    this.ctx = null
  }

  onUartRx(bytes: Uint8Array): void {
    if (this.protocol !== 'simple') return
    for (const byte of bytes) {
      if (byte === 0x0d) {
        const text = String.fromCharCode(...this.line)
        this.line = []
        this.handleLine(text)
      } else if (byte !== 0x0a) {
        // Cap a runaway line rather than growing without bound.
        if (this.line.length < 1024) this.line.push(byte)
      }
    }
  }

  onCommand(command: string, args?: Record<string, unknown>): void {
    if (command === 'present') {
      const uid = String(args?.['uid'] ?? '').replace(/[^0-9a-fA-F]/g, '')
      const type = tagTypeCode(args?.['type'] ?? 'mifare')
      if (uid.length === 0 || uid.length % 2 !== 0 || uid.length > 32) {
        this.ctx?.diagnose(
          'warn',
          `TWN4: card UID "${String(args?.['uid'])}" must be 1–16 hex bytes`
        )
        return
      }
      if (type === null) {
        this.ctx?.diagnose('warn', `TWN4: unknown tag type "${String(args?.['type'])}"`)
        return
      }
      const bytes = Uint8Array.from(uid.match(/../g)!, (h) => parseInt(h, 16))
      this.card = { type, uid: bytes }
      this.ctx?.emit({
        kind: 'card',
        summary: `Card presented: ${tagTypeName(type)} ${hex(bytes)}`
      })
      if (this.protocol === 'id') {
        this.reads++
        this.send(`${hex(bytes)}\r`)
      }
    } else if (command === 'remove') {
      if (this.card) this.ctx?.emit({ kind: 'card', summary: 'Card removed' })
      this.card = null
    } else if (
      command === 'setParam' &&
      (args?.['protocol'] === 'simple' || args?.['protocol'] === 'id')
    ) {
      this.protocol = args['protocol']
    } else {
      this.ctx?.diagnose('warn', `TWN4: unrecognized command "${command}"`)
    }
  }

  private send(text: string): void {
    this.ctx?.uartTx?.(Uint8Array.from(text, (c) => c.charCodeAt(0)))
  }

  private reply(bytes: number[]): void {
    this.lastReply = hex(bytes)
    this.send(`${this.lastReply}\r`)
  }

  private handleLine(raw: string): void {
    const text = raw.trim()
    if (text.length === 0) return
    this.commands++
    this.lastCommand = text.toUpperCase()
    if (!/^([0-9a-fA-F]{2})+$/.test(text)) {
      this.ctx?.diagnose('warn', `TWN4: "${text}" is not a hex Simple Protocol command`)
      this.reply([ERR_PARSER])
      return
    }
    const bytes = Uint8Array.from(text.match(/../g)!, (h) => parseInt(h, 16))
    if (bytes.length < 2) {
      this.reply([ERR_PARSER])
      return
    }
    const fn = (bytes[0]! << 8) | bytes[1]!
    const args = bytes.subarray(2)
    const want = ARG_BYTES[fn]
    if (want === undefined) {
      this.ctx?.diagnose(
        'error',
        `TWN4: Simple Protocol function ${hex([bytes[0]!, bytes[1]!])} is not modelled`
      )
      this.reply([ERR_UNKNOWN_FUNCTION])
      return
    }
    if (args.length < want) {
      this.reply([ERR_MISSING_PARAMETER])
      return
    }
    if (args.length > want) {
      this.reply([ERR_UNUSED_PARAMETERS])
      return
    }
    this.reply([ERR_NONE, ...this.call(fn, args)])
  }

  /** Run one API function; returns its result bytes (after the status). */
  private call(fn: number, a: Uint8Array): number[] {
    switch (fn) {
      case 0x0001:
        this.reset()
        return []
      case 0x0003:
        return u32Bytes(Date.now() - this.bootMs)
      case 0x0004: {
        const version = TWN4_VERSION.slice(0, a[0]!)
        return [version.length, ...Array.from(version, (c) => c.charCodeAt(0))]
      }
      case 0x0005:
        return [USB_TYPE_NONE]
      case 0x0006:
        return [DEVICE_TYPE_MULTITECH3]
      case 0x0400:
      case 0x0401:
        return []
      case 0x0402:
        this.setGpio(this.gpioOut | a[0]!)
        return []
      case 0x0403:
        this.setGpio(this.gpioOut & ~a[0]!)
        return []
      case 0x0404:
      case 0x0405:
        this.setGpio(this.gpioOut ^ a[0]!)
        return []
      case 0x0406:
        return [(this.gpioOut >> a[0]!) & 1]
      case 0x0407: {
        this.beeps++
        const hz = a[1]! | (a[2]! << 8)
        const on = a[3]! | (a[4]! << 8)
        this.ctx?.emit({ kind: 'beep', summary: `Beep ${hz} Hz for ${on} ms at volume ${a[0]}` })
        return []
      }
      case 0x0408:
        this.diagLed = true
        return []
      case 0x0409:
        this.diagLed = false
        return []
      case 0x040a:
        this.diagLed = !this.diagLed
        return []
      case 0x040b:
        return [this.diagLed ? 1 : 0]
      case 0x0500:
        return this.searchTag(a[0]!)
      case 0x0501:
        this.rfOn = false
        return []
      case 0x0502:
        this.lfMask = u32(a, 0) & SUPPORTED_LF
        this.hfMask = u32(a, 4) & SUPPORTED_HF
        return []
      case 0x0503:
        return [...u32Bytes(this.lfMask), ...u32Bytes(this.hfMask)]
      case 0x0504:
        return [...u32Bytes(SUPPORTED_LF), ...u32Bytes(SUPPORTED_HF)]
      default:
        return []
    }
  }

  private searchTag(maxIdBytes: number): number[] {
    this.rfOn = true
    const card = this.card
    if (!card) return [0]
    const mask = isLf(card.type) ? this.lfMask : this.hfMask
    if ((mask & (1 << (card.type & 0x1f))) === 0) return [0]
    const id = card.uid.subarray(0, maxIdBytes)
    this.reads++
    return [1, card.type, Math.min(card.uid.length * 8, 255), id.length, ...id]
  }

  private setGpio(bits: number): void {
    const changed = (bits ^ this.gpioOut) & 0x07
    this.gpioOut = bits & 0xff
    for (let i = 0; i < LED_NAMES.length; i++) {
      if (changed & (1 << i)) {
        this.ctx?.emit({
          kind: 'led',
          summary: `${LED_NAMES[i]} LED ${bits & (1 << i) ? 'on' : 'off'}`
        })
      }
    }
  }

  snapshot(): DeviceSnapshot {
    return {
      protocol: this.protocol,
      card: this.card ? { type: tagTypeName(this.card.type), uid: hex(this.card.uid) } : null,
      rfOn: this.rfOn,
      leds: {
        red: (this.gpioOut & 1) !== 0,
        green: (this.gpioOut & 2) !== 0,
        yellow: (this.gpioOut & 4) !== 0
      },
      lfMask: this.lfMask,
      hfMask: this.hfMask,
      lastCommand: this.lastCommand,
      lastReply: this.lastReply
    }
  }

  meter(id: string): number | undefined {
    if (id === 'commands') return this.commands
    if (id === 'reads') return this.reads
    if (id === 'beeps') return this.beeps
    return undefined
  }
}

export const twn4Descriptor: DeviceModelDescriptor = {
  id: 'elatec.twn4',
  summary:
    'Elatec TWN4 MultiTech LF/HF RFID reader on a UART: Simple Protocol (ASCII) SearchTag / tag types / version / beep / LEDs, or plain hex-ID output; cards presented from the IN panel.',
  create: (options) =>
    new Twn4Model({
      protocol: options?.['protocol'] === 'id' ? 'id' : 'simple'
    })
}
