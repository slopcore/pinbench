---
title: Display pipeline
area: display
status: done
status_note: 'home-screen content is radio-gated — see [[status]]'
---

# Display pipeline

Real firmware pixels reach the emulated LCD's OUT panel: `St7789Spi::display()`
running on an emulated Xtensa core → GP-SPI2 controller → the socket bridge → the
`sitronix.st7789` model → `St7789Screen.tsx`. Editing the firmware's UI source
and rebuilding changes what is drawn — the whole source→emulator→pixels loop is
live.

## Framebuffer side channel

A 153,600-byte GRAM must not travel in a device snapshot — `DeviceHost`
JSON-stringifies every snapshot to dedupe it, which is the exact failure
[ADR 0001](../adr/0001-device-model-boundary.md) exists to prevent. Instead:

- `snapshot()` is scalars only.
- The host pulls `takeFrame()` on a ~30 fps timer and emits a
  `device:framebuffer` IPC message: pixel buffer + dirty rect + MADCTL + format
  (`rgb565` | `mono1`) + `inverted` flag.
- `St7789Screen.tsx` keeps a persistent `ImageData` and `putImageData`s only the
  changed region — a partial update never repaints the whole canvas. The dirty
  rect is transformed through the same `MADCTL.MV` transpose as the pixels.

## Orientation

The panel renders landscape from a portrait GRAM. `MADCTL.MV` maps the column
address to GRAM Y and the row address to GRAM X; `CASET`/`RASET` clamp bounds
swap with MV so a per-row `setAddrWindow` addressing `0..319` is not clipped to 239. `INVON` is applied at scan-out (the model keeps raw pixels, the renderer
XORs the `inverted` flag) so a mid-frame toggle survives.

## SPI routing and bus contention

Three M9 SPI devices share SCK/MOSI/MISO. Selection is by **observed GPIO
level**, not a hardware chip-select: an `Op.Gpio` frame carries pin + level, the
host maps it to part+signal, and routes each `Op.Xfer` to whichever device's
select (`CS`/`NSS`/`SS`/`CSB`) is low. Two selects low on one bus raises a named
**bus-contention diagnostic**.

## Meters

`flush` is a per-frame span latched on the first `RAMWR` after a `takeFrame`
(MeshCore issues one RAMWR per row, ~240/frame, so a naive per-byte measure read
multi-second garbage). Live: 2–9 ms/frame, 7–12 transactions/frame — the FIFO
bulk hook batches `transferBytes` into ≤64-byte chunks, so no native-model
rewrite is indicated. `dirtyRectCount` and host-filled `busShare` are real.

## E-ink

The Heltec board renders a 1bpp framebuffer through `EInkScreen` — the `format`
discriminator on `DeviceFramebufferMessage` was the one additive change the
second display class needed. See [[devices]] (`ultrachip.uc8151`).
