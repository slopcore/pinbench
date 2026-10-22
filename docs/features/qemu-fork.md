---
title: The QEMU fork patches
area: emulation
status: done
---

# The QEMU fork patches

The `espressif/qemu` fork (tag `esp-develop-9.2.2-20260417`) models only SPI1
(flash/PSRAM) and has an empty GPIO write stub and no I2C at all. PinBench adds
the following, kept minimal and documented. `qemu/apply.sh` applies them, wired
into `npm run setup:emulator` with a `.pinbench-applied` marker for idempotency.

## GP-SPI2 / GP-SPI3 controllers

`qemu/hw/ssi/pinbench_gpspi.c` — the general-purpose `SPI_*` register layout
every M9 peripheral needs. Scoped to the Arduino CPU-FIFO path:
`SPI_CMD.USR`/`.UPDATE` (self-clearing), `SPI_MS_DLEN`, `SPI_USER*`,
`SPI_W0..W15`. Offsets confirmed against the M9's own
`framework-arduinoespressif32` `spi_reg.h` (`SPI_CMD` 0x0, `SPI_USER` 0x10,
`SPI_MS_DLEN` 0x1C, `SPI_W0..W15` 0x98–0xD4, `SPI_USR` bit 24, `SPI_UPDATE` bit 23) and exercised live — MeshCore's ST7789 init decodes byte-for-byte. Unknown
registers are absorbed so clock/DMA/timing pokes read back and nothing faults.

Mapped at `0x60024000` / `0x60025000` in
`qemu/hw/xtensa/pinbench_esp32s3.c`.

## The bulk hook

On one `SPI_USR` pulse the whole FIFO window is handed to the device host in a
single socket round trip — [ADR 0001](../adr/0001-device-model-boundary.md)'s
"few large transactions, not thousands of small ones", realised in the
controller. `spiTransferBytesNL` is a pure CPU-FIFO loop in ≤64-byte chunks with
no DMA, so the FIFO path is the whole story.

## GPIO output

`qemu/hw/gpio/esp32_gpio.c` — a pinned replacement (`esp32_gpio_write` was `{ }`
upstream). Models `OUT`/`OUT1`/`ENABLE` and their `W1TS`/`W1TC` aliases, and
forwards every level _change_ as an `Op.Gpio` frame. A write of 0 over a reset-0
`OUT` register is a no-change and is not forwarded on its own — but the moment a
pin's `ENABLE` bit goes 0→1 (`pinMode(pin, OUTPUT)`) its current `OUT` level is
forwarded unconditionally, even if that level is 0. That enable edge is the real
electrical event ("the SoC now drives this line"), and a device model that
_probes_ a line it drives depends on seeing it: the heltec e-ink `detectEInk()`
does `pinMode(RST, OUTPUT); digitalWrite(RST, LOW)` over a never-touched pin and
reads BUSY to pick its driver — without the enable-edge forward the model never
learns RST was asserted, feeds back a stale idle level, and the guest selects the
wrong controller and spins forever in its BUSY-poll `wait()`. Models still want a
sensible power-on default for lines that are only ever read (the ST7789 powers on
`dc` LOW / backlight lit).

## GPIO input (host→guest line reads)

A guest `GPIO_IN` / `GPIO_IN1` read of a pin in the host's input mask issues an
`Op.GpioRead` (0x06) frame — the same shape as `Op.Xfer`, synchronous, no async
machinery, no CPU-interrupt raise (RadioLib level-polls BUSY and DIO9). The mask
is an 8-byte LE bitmask of the input pins, delivered in the `Hello` reply;
`esp32_gpio.c` overlays `pinbench_host_gpio_read()` onto `GPIO_IN`/`GPIO_IN1` for
the masked bits only. On any socket failure it returns 0 — a _released_ line,
never `0xFF`, because a stuck-high BUSY would hang the poll.

## The socket bridge

`qemu/hw/misc/pinbench_host.c` — the 20-byte device-model wire protocol
([[device-model-api]]), a lazy singleton keyed by `PINBENCH_DEVICE_SOCKET` (unset
⇒ every call a no-op, so a stock `qemu-system-xtensa` is unaffected), a `Hello`
handshake, and a socket-read timeout after which the guest sees `0xFF` — the
backstop for a hung device model.

## Not yet in the fork

- **A faster I2C NAK (and, later, device models).** Upstream's
  `hw/i2c/esp32_i2c.c` is wired into the S3 machine and NAKs any address with no
  slave, so a guest bus scan finds nothing and moves on with no driver hang. But
  the M9 firmware's `EnvironmentSensorManager::begin()` walks `0x08..0x77` (112
  probes) and the NAK path is slow: the M9 takes ~2.5 min of wall-clock to reach
  its main loop. **Not yet measured** where that time goes — the sensor scan is
  the prime suspect, but `SPIFFS.begin(true)` formatting a fresh 16 MB partition
  runs just above it in `setup()` and is a plausible co-contributor; a
  `--reporter=verbose` run with timestamped serial would settle it. The lever is
  the per-NAK cost, not device models (backing four sensor addresses with models
  makes their drivers run and leaves 108 slow NAKs). Next M9 item. See
  [[status]].
- _(historical)_ The `__pinMode(): Invalid pin selected` / `gpio_set_level(227)`
  line at ~1.3 s is a benign display-init artifact (a `-1` VDD-control pin in
  `ST7789Display::begin`), four seconds before radio bring-up — it never blocked
  anything. The M9 `-707` was `RADIOLIB_ERR_SPI_CMD_FAILED` from a firmware
  `SPI.begin()` omission plus byte-framing in `lr1110.ts`; both fixed.
- A generic-SoC console/VFS init assert (`startup.c:320`) reached on the plain
  `esp32-s3-devkitc-1` variant (the Heltec board), not fixed by the DIO switch.
- `GPIO_STATUS` / interrupt-enable / edge config (no milestone needs a real ISR
  yet).
- RMT and LEDC peripherals (NeoPixel, servo — a future milestone).
