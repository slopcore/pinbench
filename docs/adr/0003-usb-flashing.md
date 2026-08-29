# ADR 0003 — Flashing real hardware over USB

- **Status.** Accepted
- **Date.** 2026-08-29
- **Milestone.** M17 (USB flash)
- **Amends.** [Decision #1](../decisions.md) — "Real USB flashing is out of
  scope for v1" — and the matching [non-goal](../non-goals.md). Simulation is
  still the default and the whole reason PinBench exists; USB flash is an
  opt-in last step, not a change of posture.

## Context

PinBench builds a real MeshCore image from a PlatformIO checkout and boots it
under emulation. Once the board on the desk is the goal, the user still has to
leave the app and run `pio run -t upload` — or the MeshCore web flasher — by
hand. The web flasher's two buttons ("Flash" and "Erase & flash") are the
shape people already expect. We want that inside PinBench.

The constraints:

- **The emulator image must never be written to a board.** `overrideConfigIni`
  forces `board_build.flash_mode = dio` and a `dio_opi`/`dio_qspi`
  `memory_type` on every env, because QEMU's `m25p80` flash model implements no
  QPI. `mergeBinArgs` then zero-pads the image to the full flash with
  `--fill-flash-size`. Writing that at `0x0` would flash the wrong memory mode
  **and** wipe NVS regardless of which button was pressed.
- **No native modules.** `serialport` would be a native addon and would break
  the "`npm run check` on three platforms, no build step" story.
- **`erase_flash` is destructive.** It wipes NVS, which on a MeshCore node
  holds the identity keypair. Unrecoverable.

## Decision

A separate pipeline, `UsbFlashRunner`, modelled on `BuildRunner`:

1. **Rebuild board-native.** `pio run -e <env>` with **no** `-c override`, so
   the artifacts are the board's real flash/PSRAM mode. This always runs; the
   emulator build and the board build share `.pio/build/<env>` and are
   otherwise indistinguishable on disk.
2. **`erase_flash`** (only in "Erase + flash" mode) via `esptool`.
3. **`write_flash`** of the four discrete regions at their offsets
   (`FLASH_LAYOUT`, shared with the QEMU merge) — no `--fill-flash-size`, so a
   plain "Flash" leaves NVS intact. `--flash_size detect` reads the real part.

`esptool` and its Python interpreter are the ones already resolved inside the
PlatformIO core dir (`locateFlashTools`, `pythonForPio`). Port enumeration is
`pio device list --json-output` — no new dependency, same resolved `pio`.

The renderer gets a modal (`UsbFlashDialog`): pick a port, pick a mode, watch
the streamed log. "Erase + flash" carries an inline, unmissable warning and a
red confirm button; the mode picker *is* the confirmation gate. The menu
command `build.flashUsb` (⌘⇧U) and a toolbar button both open it. The ACP
`menu_command` denylist blocks `build.flashUsb` — an agent must not write
hardware.

### Rejected

- **Web Serial / `esptool-js` in the renderer.** Would need `contextIsolation`
  holes or a `<webview>`, and duplicates the esptool we already ship.
- **`pio run -t upload`.** Hands port choice and progress to PlatformIO's
  console; no structured state for the UI, and it rebuilds with whatever
  config is on disk.
- **Flashing the merged image with a re-merge at real flash mode.** Still
  zero-pads; still no "flash only". Two esptool invocations of discrete
  regions is simpler and matches what `-t upload` does anyway.

## Consequences

- PinBench can take a checkout to a running board without a terminal.
- One flash at a time, guarded like builds. Cancel kills the esptool process
  group.
- A wrong port, a board not in download mode, or a missing `esptool` surface as
  a `failed` state with the process's stderr — no auto-retry.
- Windows/Linux port names (`COM7`, `/dev/ttyACM0`) come straight from
  `pio device list`; nothing platform-specific in our code.
- The merged-image path (`flash.ts`) is now explicitly emulator-only in its
  doc comment, and `mergeBinArgs` takes the chip from the board rather than
  hardcoding `esp32s3`.
