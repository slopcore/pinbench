# M0 spike — measuring the emulation bridge

Throwaway code whose only output is
[`docs/adr/0001-device-model-boundary.md`](../docs/adr/0001-device-model-boundary.md).
It is kept in the repository so the ADR's numbers can be re-run and disputed,
not because any of it is meant to survive into PinBench proper.

Nothing here is wired into the application. Delete it once M6 has shipped and
the ADR's conclusions have been proven in real code.

## What is in here

| Path | What it is |
|---|---|
| `qemu/hw/ssi/pinbench_bridge.c` | SSI peripheral that forwards transactions over a Unix socket, and blocks for the reply |
| `qemu/hw/misc/pinbench_bench.c` | The same device model written natively in C, plus the MMIO stopwatch that times both |
| `qemu/include/hw/misc/*.h` | Wire protocol and the one-call machine hook |
| `qemu/apply.sh` | Copies the above into a QEMU checkout and registers it with meson. Idempotent |
| `bridge-server/server.mjs` | The Node-hosted device model. Must stay behaviourally identical to the C one |
| `firmware/bench/` | Arduino firmware that drives the harness and prints CSV on UART0 |
| `bin/mkflash.sh` | Merges a PlatformIO build into one flash image for QEMU |
| `run-bench.sh` | Starts the device host, boots QEMU, collects the CSV |
| `results/` | What the runs produced |

## Running it

Needs `gcc`, `ninja`, `pkg-config`, Node 22+, PlatformIO, and the `glib`,
`pixman`, `libgcrypt` and `libslirp` development headers. `--disable-slirp`
does not actually stop `net/slirp.c` from being compiled, so libslirp is
effectively required.

```sh
git clone --depth 1 --branch esp-develop-9.2.2-20260417 \
  https://github.com/espressif/qemu.git

spike/qemu/apply.sh ./qemu

cd qemu && mkdir -p build && cd build
../configure --target-list=xtensa-softmmu --disable-docs --disable-sdl \
  --disable-gtk --disable-vnc --disable-werror --disable-capstone \
  --disable-tools --enable-slirp --enable-debug-info
ninja
cd ../..

pio run -d spike/firmware/bench
spike/bin/mkflash.sh spike/firmware/bench/.pio/build/esp32s3 bench-flash.bin
spike/run-bench.sh ./qemu/build bench-flash.bin
```

The last command writes `spike/results/bench.csv` and prints it.

## How the harness works

`pinbench_spike_attach()` does nothing unless `PINBENCH_BRIDGE_SOCKET` is set in
QEMU's environment — an environment variable rather than a machine property
precisely so this scaffolding never looks like a supported feature. When it is
set, a `pinbench-bridge` (CS 2) and a `pinbench-native` (CS 3) join SPI1's bus
and the stopwatch appears at `0x60041000`.

Firmware writes mode, length and iteration count, writes `GO`, and reads back
elapsed nanoseconds plus an FNV-1a checksum of the bytes it got back. The run
happens synchronously inside the MMIO write, which is exactly what a blocking
device model does to a vCPU.

Modes:

| # | Mode | What it measures |
|---|---|---|
| 0 | `native-direct` | C model, one function call per byte |
| 1 | `bridge-byte` | Node model, one socket round trip per byte |
| 2 | `bridge-burst` | Node model, whole buffer in one round trip |
| 3 | `native-burst` | C model, whole buffer via memcpy |
| 4 | `ssi-native` | C model reached through QEMU's `ssi_transfer()` |
| 5 | `ssi-bridge` | Node model through `ssi_transfer()`, per byte |

**The checksum is the test.** The C and JS models implement the same byte sink;
if a mode reports a different checksum from the others for the same input, the
two implementations have drifted and the timings are comparing different work.
Do not trust a run whose checksums disagree.

## Traps worth knowing

- **CS is active low and defaults to selected.** `ssi_transfer()` broadcasts to
  every peripheral on the bus, and `ssi_transfer_raw_default()` calls a
  `SSI_CS_LOW` device whenever its CS input is low — which is its power-on
  state. Leaving the bridge selected during a `ssi-native` run silently sends
  every byte over the socket too, and turns a 34 ns measurement into a 45 µs
  one. The harness now deselects both peripherals explicitly before each run.
- **Build firmware DIO, not QIO.** QEMU's `m25p80` flash model does not
  implement the QPI commands a QIO bootloader issues. The symptom is a boot loop
  asserting in `esp_vfs_console_register()`, which points nowhere near the real
  cause. Set `board_build.flash_mode = dio` and
  `board_build.arduino.memory_type = dio_qspi`.
- **No `-m` means no PSRAM**, silently — the machine's `default_ram_size` is 0.
  For octal PSRAM parts such as the M9's ESP32-S3-R8, add
  `-global ssi_psram.is_octal=true` as well.
