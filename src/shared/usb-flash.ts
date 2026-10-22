/**
 * The USB-flash pipeline's pure layer: its state machine, the esptool argv for
 * `erase_flash` / `write_flash`, and the parser for `pio device list`.
 *
 * This is the one path in PinBench that talks to real hardware. It never writes
 * the merged QEMU image — that is DIO-forced and zero-padded for the emulator
 * (`src/shared/flash.ts`). It writes the board-native build's discrete regions
 * (`FLASH_LAYOUT`) to the port the user picked.
 */

import { flashRegionArgs } from './flash'

export type UsbFlashMode = 'flash' | 'erase-flash'

export type UsbFlashState =
  'idle' | 'building' | 'erasing' | 'flashing' | 'done' | 'failed' | 'cancelled'

export interface UsbFlashStatus {
  state: UsbFlashState
  mode?: UsbFlashMode
  /** Serial port being written, once one is chosen. */
  port?: string
  /** Why the run entered `failed`, if it did. */
  error?: string
  /** 0–100 while `flashing`, from esptool's `Writing at … (NN %)` lines. */
  percent?: number
}

export const INITIAL_USB_FLASH_STATUS: UsbFlashStatus = { state: 'idle' }

const VALID_TRANSITIONS: Record<UsbFlashState, UsbFlashState[]> = {
  idle: ['building'],
  building: ['erasing', 'flashing', 'failed', 'cancelled'],
  erasing: ['flashing', 'failed', 'cancelled'],
  flashing: ['done', 'failed', 'cancelled'],
  done: ['building'],
  failed: ['building'],
  cancelled: ['building']
}

export function canTransition(from: UsbFlashState, to: UsbFlashState): boolean {
  return from === to || VALID_TRANSITIONS[from].includes(to)
}

export function transition(from: UsbFlashState, to: UsbFlashState): UsbFlashState {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid USB-flash transition: ${from} → ${to}`)
  }
  return to
}

export function isUsbFlashRunning(state: UsbFlashState): boolean {
  return state === 'building' || state === 'erasing' || state === 'flashing'
}

const BUTTON_LABELS: Record<UsbFlashState, string> = {
  idle: 'Flash over USB',
  building: 'Building…',
  erasing: 'Erasing…',
  flashing: 'Writing…',
  done: 'Flashed ✓',
  failed: 'Flash failed',
  cancelled: 'Flash over USB'
}

export function usbFlashButtonLabel(state: UsbFlashState): string {
  return BUTTON_LABELS[state]
}

/** A serial device the user could flash, from `pio device list`. */
export interface SerialPortInfo {
  /** e.g. `/dev/cu.usbserial-0001`, `COM7`. */
  port: string
  /** Human label, e.g. `USB Single Serial`. Empty when the OS gives none. */
  description: string
  /** e.g. `USB VID:PID=303A:1001 …`. Empty when unknown. */
  hwid: string
}

interface RawPort {
  port?: unknown
  description?: unknown
  hwid?: unknown
}

/**
 * `pio device list --json-output` emits `[{ port, description, hwid }, …]`.
 * Ports whose `hwid` is `n/a` are Bluetooth / virtual entries PlatformIO itself
 * flags as not real — drop them so the picker only offers wired devices.
 */
export function parsePortList(json: unknown): SerialPortInfo[] {
  if (!Array.isArray(json)) return []
  const ports: SerialPortInfo[] = []
  for (const raw of json as RawPort[]) {
    if (typeof raw?.port !== 'string' || raw.port.length === 0) continue
    const hwid = typeof raw.hwid === 'string' ? raw.hwid : ''
    if (hwid.toLowerCase() === 'n/a') continue
    ports.push({
      port: raw.port,
      description:
        typeof raw.description === 'string' && raw.description !== 'n/a' ? raw.description : '',
      hwid
    })
  }
  return ports
}

/** esptool argv (after the script path) for a full-chip erase. */
export function eraseFlashArgs(chip: string, port: string): string[] {
  return ['--chip', chip, '--port', port, '--before', 'default_reset', 'erase_flash']
}

export interface WriteFlashInput {
  chip: string
  port: string
  /** `.pio/build/<env>/` from a build with no emulator override. */
  buildDir: string
  /** OTA selector blob in the PlatformIO core dir. */
  bootApp0: string
  join: (...parts: string[]) => string
}

/**
 * esptool argv (after the script path) for `write_flash`. `--flash_size detect`
 * reads the real part rather than trusting the board file, and no
 * `--fill-flash-size`: only the four regions are touched, so a plain `flash`
 * leaves NVS (the node's identity/keys) intact.
 */
export function writeFlashArgs({
  chip,
  port,
  buildDir,
  bootApp0,
  join
}: WriteFlashInput): string[] {
  return [
    '--chip',
    chip,
    '--port',
    port,
    '--before',
    'default_reset',
    '--after',
    'hard_reset',
    'write_flash',
    '-z',
    '--flash_mode',
    'dio',
    '--flash_freq',
    '80m',
    '--flash_size',
    'detect',
    ...flashRegionArgs(buildDir, bootApp0, join)
  ]
}

const PERCENT_RE = /\((\d{1,3})\s*%\)/

/** Pull the percentage out of an esptool `Writing at 0x… (37 %)` line. */
export function flashPercentFromLine(line: string): number | null {
  const match = PERCENT_RE.exec(line)
  if (!match) return null
  const percent = Number(match[1])
  return percent >= 0 && percent <= 100 ? percent : null
}
