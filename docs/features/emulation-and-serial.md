---
title: Emulation and serial console
area: emulation
status: done
---

# Emulation and serial console

PinBench boots a real firmware `.bin` (or a PlatformIO `.pio/build/<env>/`
directory) on an emulated ESP32-S3. The CPU genuinely executes your firmware; no
part of the board is mocked at the instruction level.

## Emulator supervisor

`src/main/emulator.ts` runs QEMU as a supervised child process:

- Locates the QEMU binary: `PINBENCH_QEMU` env → `.qemu/build/` →
  `~/.espressif/` → `PATH`. Absence surfaces a crash diagnostic.
- State machine: `idle → starting → running → stopping → crashed`, with tests.
- Spawns with `-machine esp32s3`, `-serial mon:stdio` (UART0 and monitor
  multiplexed on one stdio chardev — the earlier `-monitor none -serial stdio`
  form silently disconnected the UART), and board-derived PSRAM flags
  (`-m <size>`, `-global ssi_psram.is_octal=true` for octal parts).
- Guarantees the child dies with the app (disposed on `before-quit`).
- Run controls: Start / Stop / Reset, with emulator state shown in the title bar.

`npm run setup:emulator` builds the `espressif/qemu` fork (tag
`esp-develop-9.2.2-20260417`, gcrypt enabled) into `.qemu/`. `npm run dev` runs a
preflight that verifies `esp32s3` machine support. See [[qemu-fork]] for the
patches PinBench applies.

## Serial console

UART0 output streams into the **Serial monitor** dock:

- Monospace, timestamped from emulator start, ANSI colour stripped.
- Autoscroll with scroll-lock on manual scroll.
- Batched at 25 ms, ring-buffered to 10K lines so a chatty firmware cannot
  exhaust memory.
- **Serial input**: type in the dock and bytes reach the firmware's UART.

## Board launch options

Emulator launch args come from `BoardDefinition.emulator` — `machine`,
`psramSize`, `psramOctal`, `flashSize` — not hardcoded. See [[board-definitions]].
