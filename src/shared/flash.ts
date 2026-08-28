/**
 * Assembling the single raw flash image QEMU boots from the four pieces
 * PlatformIO produces. This is `spike/bin/mkflash.sh` ported into the app so
 * Build & flash needs no shell script on the user's PATH.
 */

/** `8M` / `16MB` / `4194304` → bytes. */
export function parseSize(size: string): number {
  const match = /^(\d+)\s*(gb|g|mb|m|kb|k|b)?$/i.exec(size.trim())
  if (!match) throw new Error(`Unparseable flash size: ${size}`)
  const value = Number(match[1])
  switch ((match[2] ?? 'b').toLowerCase()) {
    case 'g':
    case 'gb':
      return value * 1024 * 1024 * 1024
    case 'm':
    case 'mb':
      return value * 1024 * 1024
    case 'k':
    case 'kb':
      return value * 1024
    default:
      return value
  }
}

export interface MergeBinInput {
  /** `.pio/build/<env>/` — holds bootloader.bin, partitions.bin, firmware.bin. */
  buildDir: string
  /** `framework-arduinoespressif32/tools/partitions/boot_app0.bin`. */
  bootApp0: string
  /** Where to write the merged image. */
  out: string
  /** Total image size in bytes; the image is zero-filled to this. */
  sizeBytes: number
  join: (...parts: string[]) => string
}

/**
 * esptool argv (after `esptool.py`). Offsets are the Arduino-ESP32 layout the
 * spike validated: bootloader at 0, partition table at 0x8000, the OTA selector
 * at 0xe000, the app at 0x10000.
 */
export function mergeBinArgs({
  buildDir,
  bootApp0,
  out,
  sizeBytes,
  join
}: MergeBinInput): string[] {
  const megabytes = Math.max(1, Math.round(sizeBytes / (1024 * 1024)))
  return [
    '--chip',
    'esp32s3',
    'merge_bin',
    '-o',
    out,
    '--flash_mode',
    'dio',
    '--flash_freq',
    '80m',
    '--flash_size',
    `${megabytes}MB`,
    '--fill-flash-size',
    `${megabytes}MB`,
    '0x0',
    join(buildDir, 'bootloader.bin'),
    '0x8000',
    join(buildDir, 'partitions.bin'),
    '0xe000',
    bootApp0,
    '0x10000',
    join(buildDir, 'firmware.bin')
  ]
}

/** The build artifacts the merge step consumes, relative to a build dir. */
export const BUILD_ARTIFACTS = ['bootloader.bin', 'partitions.bin', 'firmware.bin'] as const
