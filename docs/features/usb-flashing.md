---
title: Flash real hardware over USB
area: build
status: implemented — not yet exercised on hardware
---

# Flash real hardware over USB

> **Status.** The pipeline is built and unit-tested (shared argv/state layer,
> `UsbFlashRunner` against a fake spawn, the dialog). It has **not** yet been
> run against a physical board — the same bar as the Heltec models, which are
> "proven by harness" but not live.

PinBench is emulation-first, but the last step is often a board on the desk.
**Flash over USB** (⌘⇧U, or the toolbar's _Flash USB…_ button) takes the
attached PlatformIO checkout to a real device with `esptool` — the two modes
the MeshCore web flasher offers:

- **Flash** — write bootloader, partition table, OTA selector and firmware.
  NVS is left untouched, so the node keeps its saved keys and settings.
- **Erase + flash** — `esptool erase_flash` first, wiping the whole chip
  (including the identity keypair in NVS), then write. Unrecoverable; the
  dialog says so in red and the confirm button is the gate.

See [ADR 0003](../adr/0003-usb-flashing.md) for why this amends locked
decision #1.

## Pipeline

`UsbFlashRunner` mirrors the [firmware build](firmware-build.md) runner —
EventEmitter, one run at a time, injected deps, `\r`-aware streaming, process-
group kill on cancel and `before-quit`.

1. **Board-native rebuild.** `pio run -e <env> -c <override>` where the
   override pins **nothing** about flash mode — a real chip wants its own
   QIO/OPI — but redirects `build_dir` to
   `<userData>/build-cache/usb-build/<project>/`. The emulator build forces DIO
   and an emulator PSRAM `memory_type` for QEMU's QPI-less flash model; keeping
   the two build trees apart stops a later Build & flash from merging QIO
   binaries into the QEMU image (`usbBuildOverrideIni`).
2. **`erase_flash`** — only in _Erase + flash_ mode.
3. **`write_flash`** — the four regions of `FLASH_LAYOUT` at their offsets
   (`0x0`, `0x8000`, `0xe000`, `0x10000`), shared with the QEMU image merge.
   No `--fill-flash-size`; `--flash_size detect` reads the real part.

`esptool` and its interpreter are the ones inside the resolved PlatformIO core
dir (`locateFlashTools`, `pythonForPio`). The chip id comes from the board
definition's `emulator.machine` (default `esp32s3`).

## Port picker

`pio device list --json-output`, parsed by `parsePortList` — no `serialport`
native module. Entries with an `n/a` hwid (Bluetooth, virtual TTYs) are
dropped. Windows `COM*` and Linux `/dev/ttyACM*` names pass straight through.
The dialog re-scans on open and on _Refresh_.

## States

`idle → building → [erasing →] flashing → done`, plus `failed` and
`cancelled`, all restartable. `flashing` carries a `percent` parsed from
esptool's `Writing at … (NN %)` lines, shown as a progress bar. A bad port, a
board not in download mode, or a missing `esptool` ends in `failed` with the
process's stderr — no auto-retry.

## Not automated

The ACP `menu_command` denylist blocks `build.flashUsb`: a coding agent driving
PinBench cannot write hardware.
