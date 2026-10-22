#!/usr/bin/env bash
# Copy the PinBench M0 spike device models into a checkout of espressif/qemu
# and register them with meson. Idempotent.
#
#   usage: apply.sh /path/to/qemu
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
QEMU="${1:?usage: apply.sh /path/to/qemu}"

install -m 644 "$HERE/hw/ssi/pinbench_bridge.c"          "$QEMU/hw/ssi/"
install -m 644 "$HERE/hw/misc/pinbench_bench.c"          "$QEMU/hw/misc/"
install -m 644 "$HERE/include/hw/misc/pinbench_bridge.h" "$QEMU/include/hw/misc/"
install -m 644 "$HERE/include/hw/misc/pinbench_bench.h"  "$QEMU/include/hw/misc/"

add_once() { grep -qF "$2" "$1" || printf '%s\n' "$2" >> "$1"; }

add_once "$QEMU/hw/ssi/meson.build" \
  "system_ss.add(when: 'CONFIG_XTENSA_ESP32S3', if_true: files('pinbench_bridge.c'))"
add_once "$QEMU/hw/misc/meson.build" \
  "system_ss.add(when: 'CONFIG_XTENSA_ESP32S3', if_true: files('pinbench_bench.c'))"

# Machine hook: one include and one call, immediately after SPI1 and its
# flash/psram peripherals are on the bus. Kept to two edits so it survives a
# rebase onto a newer espressif/qemu.
python3 - "$QEMU" <<'PYEOF'
import sys, pathlib
qemu = pathlib.Path(sys.argv[1])
f = qemu / "hw/xtensa/esp32s3.c"
s = f.read_text()
if "pinbench_spike_attach" in s:
    print("hw/xtensa/esp32s3.c already patched")
    raise SystemExit(0)

s = s.replace('#include "hw/ssi/esp32s3_spi.h"',
              '#include "hw/ssi/esp32s3_spi.h"\n#include "hw/misc/pinbench_bench.h"', 1)

anchor = """        if (machine->ram_size > 0) {
            esp32s3_machine_init_psram(ss, (uint32_t) (machine->ram_size / MiB));
        }"""
assert anchor in s, "anchor for the pinbench hook moved; re-check esp32s3.c"
s = s.replace(anchor, anchor + """
        /* PinBench M0 spike: no-op unless PINBENCH_BRIDGE_SOCKET is set. */
        pinbench_spike_attach(sys_mem,
            (SSIBus *)qdev_get_child_bus(DEVICE(&ss->spi1), "spi"));""", 1)
f.write_text(s)
print("patched hw/xtensa/esp32s3.c")
PYEOF

echo "applied to $QEMU"
