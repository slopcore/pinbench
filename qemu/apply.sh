#!/usr/bin/env bash
#
# Apply PinBench's ESP32-S3 additions to a checkout of espressif/qemu:
#
#   - hw/misc/pinbench_host.c        blocking Unix-socket bridge to the TS models
#   - hw/ssi/pinbench_gpspi.c        GP-SPI2 / GP-SPI3 controllers (do not exist upstream)
#   - hw/xtensa/pinbench_esp32s3.c   maps them onto the SoC
#   - hw/gpio/esp32_gpio.c           REPLACED: upstream models no GPIO output at all
#   - two include/ headers, one of them a replacement (esp32_gpio.h grows two banks)
#   - hw/xtensa/esp32s3.c            two inserted lines (include + attach call)
#
# Idempotent. Pinned to tag esp-develop-9.2.2-20260417; on a tag bump, re-diff
# the two replaced files against upstream.
#
#   usage: apply.sh /path/to/qemu
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
QEMU="${1:?usage: apply.sh /path/to/qemu}"

install -m 644 "$HERE/hw/misc/pinbench_host.c"            "$QEMU/hw/misc/"
install -m 644 "$HERE/hw/ssi/pinbench_gpspi.c"            "$QEMU/hw/ssi/"
install -m 644 "$HERE/hw/xtensa/pinbench_esp32s3.c"       "$QEMU/hw/xtensa/"
install -m 644 "$HERE/hw/gpio/esp32_gpio.c"              "$QEMU/hw/gpio/"
install -m 644 "$HERE/include/hw/misc/pinbench_host.h"    "$QEMU/include/hw/misc/"
install -m 644 "$HERE/include/hw/gpio/esp32_gpio.h"       "$QEMU/include/hw/gpio/"

add_once() { grep -qF "$2" "$1" || printf '%s\n' "$2" >> "$1"; }

add_once "$QEMU/hw/misc/meson.build" \
  "system_ss.add(when: 'CONFIG_XTENSA_ESP32S3', if_true: files('pinbench_host.c'))"
add_once "$QEMU/hw/ssi/meson.build" \
  "system_ss.add(when: 'CONFIG_XTENSA_ESP32S3', if_true: files('pinbench_gpspi.c'))"
add_once "$QEMU/hw/xtensa/meson.build" \
  "xtensa_ss.add(when: 'CONFIG_XTENSA_ESP32S3', if_true: files('pinbench_esp32s3.c'))"

# Two lines into the machine file: one include, one call right after the GPIO
# controller is realized. Kept minimal so it survives a rebase.
python3 - "$QEMU" <<'PYEOF'
import sys, pathlib
qemu = pathlib.Path(sys.argv[1])
f = qemu / "hw/xtensa/esp32s3.c"
s = f.read_text()
if "pinbench_esp32s3_attach" in s:
    print("hw/xtensa/esp32s3.c already patched")
    raise SystemExit(0)

inc = '#include "hw/ssi/esp32s3_spi.h"'
assert inc in s, "include anchor moved in esp32s3.c"
s = s.replace(inc, inc + '\n#include "hw/misc/pinbench_host.h"', 1)

anchor = """    /* GPIO realization */
    {
        sysbus_realize(SYS_BUS_DEVICE(&ss->gpio), &error_fatal);
        MemoryRegion *mr = sysbus_mmio_get_region(SYS_BUS_DEVICE(&ss->gpio), 0);
        memory_region_add_subregion_overlap(sys_mem, DR_REG_GPIO_BASE, mr, 0);
    }"""
assert anchor in s, "GPIO realization anchor moved in esp32s3.c"
s = s.replace(anchor, anchor + """

    /* PinBench: GP-SPI2 / GP-SPI3 controllers, bridged to the TS device models. */
    pinbench_esp32s3_attach(sys_mem);""", 1)
f.write_text(s)
print("patched hw/xtensa/esp32s3.c")
PYEOF

echo "PinBench additions applied to $QEMU"
echo "pinbench-additions: applied $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$QEMU/.pinbench-applied"
