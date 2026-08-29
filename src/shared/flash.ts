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

/**
 * One region of the ESP32 flash and where its bytes come from. Offsets are the
 * Arduino-ESP32 layout the spike validated: bootloader at 0, partition table at
 * 0x8000, the OTA selector at 0xe000, the app at 0x10000. Both the QEMU image
 * merge and the USB write (`src/shared/usb-flash.ts`) address these same four
 * regions — keep the one table.
 */
export interface FlashRegion {
  offset: string
  /** Artifact filename inside `.pio/build/<env>/`, or... */
  artifact?: (typeof BUILD_ARTIFACTS)[number]
  /** ...the OTA selector, which lives in the PlatformIO core dir, not the build. */
  bootApp0?: true
}

export const FLASH_LAYOUT: readonly FlashRegion[] = [
  { offset: '0x0', artifact: 'bootloader.bin' },
  { offset: '0x8000', artifact: 'partitions.bin' },
  { offset: '0xe000', bootApp0: true },
  { offset: '0x10000', artifact: 'firmware.bin' }
] as const

/** Resolve a region to the absolute file that fills it. */
export function regionSource(
  region: FlashRegion,
  buildDir: string,
  bootApp0: string,
  join: (...parts: string[]) => string
): string {
  return region.bootApp0 ? bootApp0 : join(buildDir, region.artifact!)
}

/** `offset file offset file …` — the shared tail of `merge_bin` and `write_flash`. */
export function flashRegionArgs(
  buildDir: string,
  bootApp0: string,
  join: (...parts: string[]) => string
): string[] {
  return FLASH_LAYOUT.flatMap((region) => [
    region.offset,
    regionSource(region, buildDir, bootApp0, join)
  ])
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
  /** QEMU `-machine`, e.g. `esp32s3`; also the esptool `--chip`. */
  chip?: string
  join: (...parts: string[]) => string
}

/**
 * esptool argv (after `esptool.py`) for the merged image QEMU boots. This is
 * emulator-only: `--fill-flash-size` zero-pads to the whole flash, so writing
 * it to a real board at 0x0 would wipe NVS. The USB path writes the discrete
 * regions instead — see `writeFlashArgs`.
 */
export function mergeBinArgs({
  buildDir,
  bootApp0,
  out,
  sizeBytes,
  chip = 'esp32s3',
  join
}: MergeBinInput): string[] {
  const megabytes = Math.max(1, Math.round(sizeBytes / (1024 * 1024)))
  return [
    '--chip',
    chip,
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
    ...flashRegionArgs(buildDir, bootApp0, join)
  ]
}

/** The build artifacts the merge step consumes, relative to a build dir. */
export const BUILD_ARTIFACTS = ['bootloader.bin', 'partitions.bin', 'firmware.bin'] as const
