import type { SerialLine } from '@shared/serial'
import type { Diagnostic } from '../components/Dock'

/**
 * Dock content for M1. These are shaped exactly like the rows M2's UART reader
 * and M3's compiler-diagnostic parser will produce, so the dock does not change
 * when the real sources arrive.
 */

export const SERIAL_FIXTURE: SerialLine[] = [
  { t: 0, text: 'ESP-ROM:esp32s3-20210327' },
  { t: 4, text: 'Build:Mar 27 2021' },
  { t: 9, text: 'rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)' },
  { t: 14, text: 'SPIWP:0xee' },
  { t: 21, text: 'mode:DIO, clock div:1' },
  { t: 33, text: 'load:0x3fce3808,len:0x44c' },
  { t: 48, text: 'entry 0x403c98d8' },
  { t: 190, text: 'I (24) boot: ESP-IDF v5.1.4 2nd stage bootloader' },
  { t: 204, text: 'I (24) boot: compile time Aug 19 2026 09:14:02' },
  { t: 233, text: 'I (26) boot: chip revision: v0.2' },
  { t: 268, text: 'I (31) boot.esp32s3: Boot SPI Speed : 80MHz' },
  { t: 301, text: 'I (36) boot.esp32s3: SPI Mode       : DIO' },
  { t: 340, text: 'I (41) esp_psram: Found 8MB PSRAM device' },
  { t: 402, text: 'MeshCore v1.7.1 (simple_repeater)' },
  { t: 415, text: 'waiting for peripheral bring-up…' }
]

export const DIAGNOSTICS_FIXTURE: Diagnostic[] = [
  {
    id: 'diag-1',
    severity: 'ok',
    message: 'Board definition loaded: ThinkNode M9 V1.0 (ESP32-S3-R8)'
  },
  {
    id: 'diag-2',
    severity: 'note',
    message: 'Emulator not configured — Build & flash is unavailable',
    file: 'docs/adr/0001-device-model-boundary.md'
  },
  {
    id: 'diag-3',
    severity: 'info',
    message: 'SPI0 carries three chip selects: LR_NSS, LCD_CS, SD_CS',
    file: 'boards/thinknode-m9.board.json',
    line: 42
  },
  {
    id: 'diag-4',
    severity: 'warn',
    message: 'GPIO0 is a strapping pin and drives the CH340K auto-reset circuit',
    file: 'boards/thinknode-m9.board.json',
    line: 118
  }
]
