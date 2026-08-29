---
title: Pin-map verify and codegen
area: canvas
status: partial
status_note: "verify + codegen done; canvas editing UI (M11.3) in progress — see [[status]]"
---

# Pin-map verify and codegen

The goal is to make `board_m9.h`'s "Edit the canvas, not this file — it is
regenerated on build" true. The rule engine and the code generator are done; the
canvas-editing gestures that feed them are in progress.

## Verify pin map (`⌘B`)

`src/shared/verify.ts` — `verifyBoard(board) → VerifyFinding[]`, pure, no
Electron/DOM. Severities `warn` / `info` / `note` / `ok`. Rule families:

- a GPIO bound to two signals, minus declared `pinExceptions` (e.g. the M9's
  planned `GPIO12` = `KEY_INT` + `ESP32_WAKEUP`)
- a strapping pin (`GPIO0`/`3`/`45`/`46`) bound to a non-idle peripheral role
- a signal on a pin whose `capabilities` do not include the bus kind
- shared-bus chip-select: exactly one of `LR_NSS` / `LCD_CS` / `SD_CS` low per
  SPI bus, each on a distinct pin
- an `ok` row when a bus is clean

Each finding carries a `ref` (`part` / `pin` / `net` / `bus`) for click-through.
`findingsToDiagnostics` maps them onto dock rows with stable ids so a re-run
replaces rather than appends. `App` runs it on the in-renderer board definition
and merges rows into the Diagnostics dock.

The shipped M9 verifies **clean**: only `[note] GPIO3 is a strapping pin driving
u6:TXD` (real — GNSS UART1) and `[ok] SPI0: 3 chip-selects, each on its own pin`.
Moving `LCD_CS` to `GPIO21` produces `warn … GPIO21 is bound to 2 signals: u3:CS
+ u8:SCL`. The Heltec board verifies clean bar three real strapping-pin notes.

## Codegen

`src/shared/codegen.ts`, pure:

- **`generatePinHeader(board)`** — deterministic, name-sorted C `#define`s from
  net labels, bus roles and per-part bindings, under an include guard, led by a
  `HEADER_SENTINEL` DO-NOT-EDIT line. Golden file at
  `src/shared/__fixtures__/thinknode-m9-v1.0.pins.h`.
- **`generateBuildFlags(board)`** — the same numbers as `-D NAME=value`.
- **`headerFingerprint(text)`** — FNV-1a over the sorted `NAME=value` pairs,
  comment/whitespace-insensitive, no crypto dependency.
- **`checkHeaderDivergence(onDisk, lastFingerprint)`** — a file with no sentinel
  is `foreign`, a sentinel file whose fingerprint moved is `diverged`, no file is
  neither. Consulted before any overwrite, so a hand-edit is detected, never
  clobbered.

On build, the header is written into the project through the `-c` override path —
**never over a user file blindly** — and the flags go through the same `-c`
mechanism as the DIO override ([[firmware-build]]).

## Canvas editing (data layer done, UI in progress)

`src/shared/boardEdit.ts` — a `BoardEdit` union (`moveParty` / `resizeParty` /
`rebindPin` / `addPart` / `deletePart` / `addNet` / `deleteNet`), a pure
`applyEdit` that throws on a bad ref and prunes dangling net endpoints, and a
`BoardHistory` undo/redo stack. A `rebindPin` flows straight through
`generatePinHeader` and `verifyBoard`, so the "move the chip select, Verify flags
it, rebuild drives the new pin" chain is proven at the model level.

Still UI-side: the canvas drag / draw-net / Probe-pin gestures, `⌘Z` / `⌘⇧Z`
wiring, persisting edits to `.board.json` on save, `BuildRunner` writing the
header, clickable Verify rows.
