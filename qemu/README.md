# PinBench's ESP32-S3 additions to `espressif/qemu`

The Espressif QEMU fork models the ESP32-S3 SoC well enough to boot firmware,
but three things PinBench needs are missing. This directory is the maintained
patch set that adds them. `apply.sh` copies the files into a checkout and makes
the two-line change to the machine file; `npm run setup:emulator` runs it before
configuring, and records a `.pinbench-applied` marker in the checkout for
idempotency.

Pinned to tag **`esp-develop-9.2.2-20260417`** (the same tag `setup-emulator.sh`
clones). On a tag bump, re-diff the two _replacement_ files against upstream.

| Path                                                          | Kind             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hw/misc/pinbench_host.c` · `include/hw/misc/pinbench_host.h` | new              | Blocking Unix-socket client speaking the 20-byte protocol from `src/shared/devices/protocol.ts`. Singleton keyed by `PINBENCH_DEVICE_SOCKET`; unset ⇒ every call a no-op, so a stock `qemu-system-xtensa` run is unaffected. Carries whole SPI transactions (`Op.Xfer`) and GPIO edges (`Op.Gpio`), with a 2 s socket-read timeout after which the guest sees `0xFF` — never silent zeros.                                      |
| `hw/ssi/pinbench_gpspi.c`                                     | new              | GP-SPI2 / GP-SPI3 register model. The fork has SPI1 (flash) only; these use the general-purpose `SPI_*` layout every M9 peripheral needs. Scoped to the Arduino FIFO path (`SPI_CMD.USR`/`.UPDATE`, `SPI_MS_DLEN`, `SPI_USER*`, `SPI_W0..W15`); other registers are absorbed so driver config pokes read back and nothing faults. One `SPI_USR` pulse → one socket round trip for the whole FIFO window (ADR 0001's bulk hook). |
| `hw/gpio/esp32_gpio.c` · `include/hw/gpio/esp32_gpio.h`       | **replacement**  | Upstream `esp32_gpio_write` is `{ }` — no output modelled at all. Adds `OUT`/`OUT1`/`ENABLE` and their `W1TS`/`W1TC` aliases and forwards every level change as `Op.Gpio`. The header grows two output/enable banks on `Esp32GpioState`.                                                                                                                                                                                        |
| `hw/xtensa/pinbench_esp32s3.c`                                | new              | `pinbench_esp32s3_attach()` — maps the two GP-SPI controllers at `0x60024000` / `0x60025000`.                                                                                                                                                                                                                                                                                                                                   |
| `hw/xtensa/esp32s3.c`                                         | 2 inserted lines | one `#include`, and one call to `pinbench_esp32s3_attach(sys_mem)` right after the GPIO controller is realized. Done by `apply.sh`'s Python step against named anchors that assert if upstream moves.                                                                                                                                                                                                                           |

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
  CPU-only, ≤64 bytes/pulse), hardware CS timing, SPI interrupts, and the
  command/address phases (the panel driver sends everything as MOSI data).
