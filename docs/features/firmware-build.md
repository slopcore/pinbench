---
title: Firmware build pipeline
area: build
status: done
---

# Firmware build pipeline

**Build & flash** closes the loop from source to running emulator without leaving
the app: `pio run -e <env>` → merge image → boot in QEMU.

## PlatformIO integration

- `pio` discovery: `PINBENCH_PIO` env → repo `.pio-venv/` → an app-managed venv
  under `userData` → `PATH`. If absent, a guided bootstrap into an app-managed
  virtualenv (avoids fighting an externally-managed system Python).
- **Open project** points PinBench at a checkout, parses `platformio.ini`
  (resolving `extra_configs = variants/*/platformio.ini`), and lists environments
  for the user to pick.
- Streamed `pio run` with phase transitions (`preparing → compiling → linking →
  merging → done`) and cancellation. A `LineStreamer` renders bare `\r` progress
  as one updating line, so toolchain downloads don't look like a hang.
- Process-group kill: the build spawns `detached`; cancel sends `SIGTERM` to
  `-pid` (`taskkill /T` on Windows). Disposed on `before-quit`.
- **Build caching**: PlatformIO's own incremental build makes an unchanged
  rebuild ~1 s; the merge step is skipped when the image is newer than
  `firmware.bin` and nothing recompiled.

## Compiler diagnostics

Parsed from the transcript (`file:line:col: severity: message`), resolved to
absolute paths, sorted worst-first, and clickable through to the **Source tab**
at the offending line. Linker errors and framing noise stay in the raw log
rather than being forced into rows.

## Source tab

A lazy file tree read over IPC (confined to the project root; `.pio`, `.git`,
`node_modules` pruned), a read-only viewer with a dependency-free C/C++/INI
highlighter, and dirty markers from a recursive `fs.watch`.

## The DIO override (never touches the user's file)

QEMU's flash model implements no QPI commands, so a stock QIO build boot-loops
with an assert inside `esp_vfs_console_register()`. PinBench forces DIO flash
mode for emulator builds, and **writes its own `-c` config** that pulls the user
`platformio.ini` in via `extra_configs` and pins, per environment:

- `board_build.flash_mode = dio`
- `board_build.arduino.memory_type` = `dio_opi` for octal-PSRAM parts (the M9's
  ESP32-S3-R8), `dio_qspi` otherwise. `psramOctal` threads board →
  `BuildRequest` → `overrideConfigIni`.

The user's `platformio.ini` is never edited — the same rule the pin-map codegen
follows ([[pin-map-verify-and-codegen]]).

## Image sizing

`--flash_size` comes from `EmulatorTarget.flashSize` (the M9 is 8 M PSRAM but
**16 M flash**; `default_16MB.csv` places `spiffs`/`coredump` past 8 M).
`psramSize` is a fallback only.
