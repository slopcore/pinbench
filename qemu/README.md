# PinBench's ESP32-S3 additions to `espressif/qemu`

The Espressif QEMU fork models the ESP32-S3 SoC well enough to boot firmware,
but three things PinBench needs are missing. This directory is the maintained
patch set that adds them. `apply.sh` copies the files into a checkout and makes
the machine-file change; `npm run setup:emulator` runs it before configuring,
and records a `.pinbench-applied` marker in the checkout for idempotency.

**Keeping the build current.** This directory is versioned; the built binary in
`.qemu/` is not. `npm run predev`'s preflight warns when a file here is newer
than `.pinbench-applied`, and `npm run setup:emulator` then takes a fast path —
restore `hw/xtensa/esp32s3.c` from the clone's git, re-run `apply.sh`, and
`ninja` incrementally (seconds), skipping the clone and `./configure`.

Pinned to esp-develop commit **`febae18`** ("hw/riscv: implement ESP32-C6
machine" — untagged; everything after tag `esp-develop-9.2.2-20260417` is
RISC-V/C6-only), the same ref `setup-emulator.sh` fetches. It builds both
`qemu-system-xtensa` (S3) and `qemu-system-riscv32` (C6). On a bump, re-diff the
two _replacement_ files against upstream.

| Path                                                          | Kind             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hw/misc/pinbench_host.c` · `include/hw/misc/pinbench_host.h` | new              | Blocking Unix-socket client speaking the 20-byte protocol from `src/shared/devices/protocol.ts`. Singleton keyed by `PINBENCH_DEVICE_SOCKET`; unset ⇒ every call a no-op, so a stock `qemu-system-xtensa` run is unaffected. Carries whole SPI transactions (`Op.Xfer`) and GPIO edges (`Op.Gpio`), with a 2 s socket-read timeout after which the guest sees `0xFF` — never silent zeros.                                                                                                                                                                                                                                                                                                 |
| `hw/ssi/pinbench_gpspi.c`                                     | new              | GP-SPI2 / GP-SPI3 register model. The fork has SPI1 (flash) only; these use the general-purpose `SPI_*` layout every M9 peripheral needs. Scoped to the Arduino FIFO path (`SPI_CMD.USR`/`.UPDATE`, `SPI_MS_DLEN`, `SPI_USER*`, `SPI_W0..W15`); other registers are absorbed so driver config pokes read back and nothing faults. One `SPI_USR` pulse → one socket round trip for the whole FIFO window (ADR 0001's bulk hook).                                                                                                                                                                                                                                                            |
| `hw/gpio/esp32_gpio.c` · `include/hw/gpio/esp32_gpio.h`       | **replacement**  | Upstream `esp32_gpio_write` is `{ }` — no output modelled at all. Adds `OUT`/`OUT1`/`ENABLE` and their `W1TS`/`W1TC` aliases and forwards every level change as `Op.Gpio`. Also models the GPIO edge-interrupt path (`GPIO_PINn` INT_TYPE/INT_ENA, `STATUS`/`STATUS1` + `W1TC`, `PCPU_INT`): on a read of `GPIO_IN` / the per-CPU status regs, a host-driven input pin whose level changed and whose `GPIO_PINn` arms an edge latches a `STATUS` bit and raises the block IRQ — so a guest `attachInterrupt()` (RadioLib's radio DIO IRQ) fires on an injected edge. The header grows the output/enable banks plus `pin_cfg[54]`, `status`, `status1`, `host_in_last` on `Esp32GpioState`. |
| `hw/xtensa/pinbench_esp32s3.c`                                | new              | `pinbench_esp32s3_attach()` — maps the two GP-SPI controllers at `0x60024000` / `0x60025000`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `hw/xtensa/esp32s3.c`                                         | 3 inserted lines | one `#include`, one `sysbus_connect_irq` wiring the GPIO block's IRQ to `ETS_GPIO_INTR_SOURCE` on the interrupt matrix, and one call to `pinbench_esp32s3_attach(sys_mem)` right after the GPIO controller is realized. Done by `apply.sh`'s Python step against named anchors that assert if upstream moves.                                                                                                                                                                                                                                                                                                                                                                              |

## ESP32-C6 (Waveshare ESP32-C6-Touch-LCD-1.28)

| Path                          | Kind             | What it does                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hw/riscv/pinbench_esp32c6.c` | new              | `pinbench_esp32c6_attach()` — wires the GPIO block's IRQ to matrix source 30 and maps a DMA-capable GP-SPI2 at `0x60081000` (IRQ source 72), priority 1 over the machine's `esp32c6.peripherals` catch-all.                                                                                                                                          |
| `hw/riscv/esp32c6.c`          | 2 inserted lines | one `#include`, one attach call after the GPIO realize.                                                                                                                                                                                                                                                                                              |
| `hw/ssi/pinbench_gpspi.c`     | shared           | gains a `dma` property (off on the S3): real `DMA_INT_*` registers with `TRANS_DONE` latched per transfer and driving `irq`, and MOSI/MISO moved through the SPI2 GDMA out-/in-link. The descriptor walk is local because the fork's `esp_gdma_read_channel()` rebuilds addresses from the C3's DRAM base (`0x3FC8_0000`); C6 SRAM is `0x4080_0000`. |
| `hw/gpio/esp32_gpio.c`        | (S3 replacement) | is also the C3/C6 GPIO base class, so output forwarding and the edge-latch work unchanged; `pinbench_host.c` therefore links into `qemu-system-riscv32` too.                                                                                                                                                                                         |

This is the path IDF's `spi_master` takes — and so `esp_lcd`, Waveshare's
GC9A01 driver. Hardware CS is not synthesised yet: the device host routes by
"only modelled device on the bus", which holds while the TF card has no model.
`hw/i2c/pinbench_i2c.c` is the C6 I2C0 master (`0x60004000`, IRQ source 50):
it runs the COMD0..7 list on `TRANS_START` with the C6 opcodes (WRITE 1, STOP 2,
READ 3, END 4, RSTART 6 — not the ESP32-classic ones the fork's `esp32_i2c.c`
uses) and bridges each address phase to the host as `Op.I2c`; an address no
model claims NACKs. Writes accumulate across END so a split write stays one.

## Design notes

- **Chip-select is not modelled in the SPI controller.** On the M9 the Arduino
  driver is told to use no hardware CS (`SPI.begin(sck, miso, mosi, -1)`) and
  toggles each peripheral's select with `digitalWrite`. So device routing is
  entirely the PinBench device host's job, from the `Op.Gpio` edges it
  observes — which is also what makes the "two selects low at once" bus-fault
  diagnostic fall out for free.
- **`DC` ordering.** MeshCore's `ST7789Spi` writes the `DC` GPIO (an MMIO
  write) before the SPI transaction (another MMIO write). Both cross the same
  Unix socket in order, so the device host always has the right `DC` level
  when a transfer arrives.
- **Not modelled:** DMA transfers (the Arduino `SPIClass` FIFO path is
  CPU-only, ≤64 bytes/pulse), hardware CS timing, SPI-controller interrupts, and
  the command/address phases (the panel driver sends everything as MOSI data).
- **GPIO interrupts are edge-detected on poll, not pushed.** The socket bridge
  is a blocking guest→host client with no async channel, so a host-driven input
  edge is only noticed when the guest next reads that pin (`GPIO_IN` or the
  interrupt-status regs). Firmware that both binds an ISR and polls the line —
  MeshCore's RadioLib wrapper does — sees no added latency; a purely
  interrupt-driven, never-polled line would not wake until the next unrelated
  GPIO read.

## Licence

These files are patches to QEMU, and several (`hw/gpio/esp32_gpio.c`,
`include/hw/gpio/esp32_gpio.h`) are modified copies of Espressif's fork. Like
QEMU, they are licensed **GPL-2.0-or-later**; the full text is in
[`COPYING`](COPYING). The rest of PinBench is
MIT (see the repository `LICENSE`).

The packaged app ships a QEMU binary built from espressif/qemu at the pinned
commit above with these patches applied. This repository is the corresponding
source.
