#!/usr/bin/env bash
# Merge a PlatformIO ESP32-S3 build into a single raw flash image for QEMU.
# QEMU wants one image at offset 0; PlatformIO produces four pieces.
#
#   usage: mkflash.sh <pio-build-dir> <out.bin> [size-bytes]
set -euo pipefail
BUILD="${1:?usage: mkflash.sh <pio-build-dir> <out.bin> [size-bytes]}"
OUT="${2:?missing output path}"
SIZE="${3:-8388608}"

PIO_HOME="${PIO_HOME:-$HOME/.platformio}"
ESPTOOL="$PIO_HOME/packages/tool-esptoolpy/esptool.py"
BOOT_APP0="$PIO_HOME/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin"
PY="${PY:-python3}"

for f in "$ESPTOOL" "$BOOT_APP0"; do
  [ -f "$f" ] || { echo "missing $f - set PIO_HOME" >&2; exit 1; }
done

"$PY" "$ESPTOOL" --chip esp32s3 merge_bin -o "$OUT" \
  --flash_mode dio --flash_freq 80m \
  --flash_size "$((SIZE / 1048576))MB" \
  --fill-flash-size "$((SIZE / 1048576))MB" \
  0x0     "$BUILD/bootloader.bin" \
  0x8000  "$BUILD/partitions.bin" \
  0xe000  "$BOOT_APP0" \
  0x10000 "$BUILD/firmware.bin"

ls -l "$OUT"
