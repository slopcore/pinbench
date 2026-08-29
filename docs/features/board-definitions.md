---
title: Board definitions
area: boards
status: done
---

# Board definitions

Nothing about a board is hardcoded. A board is a validated JSON file in
`boards/`; no board-specific identifier survives in `src/` outside the
definitions. Provenance for every transcribed pin map is in `boards/README.md`.

## Schema

`parseBoard` in `src/shared/board.ts` is the schema. It **fails loud**
(`BoardValidationError` with the offending field path) rather than coercing — a
silently-mangled pin map is the "silent zeros cost you days" trap. It enforces
four cross-reference checks:

- part pins resolve to declared pins
- part buses and net buses exist
- net `partId:signal` endpoints resolve to a real signal
- exactly one `mcu` part

So loading a shipped board in a test *is* a consistency check. The definition
carries: board identity + MCU target, the pin list (with `capabilities` and
`strapping`), bus declarations, parts with pin bindings + `deviceModel` ids +
`deviceOptions` (fixed board hardware) + `config` (user-facing Inspector fields),
nets with bus membership and labels, canvas `layout` hints, `pinExceptions`
(declared intentional double-binds), and an `emulator` block (`machine`,
`psramSize`, `psramOctal`, `flashSize`).

## Loading

`board:load` runs in the **main process**: `src/main/board.ts` reads and
validates the file, hands the parsed definition to `DeviceHost`, and returns it
to the sandboxed renderer over IPC. The renderer never touches a board file.
`boardsDir()` is the repo root in dev, `resourcesPath/boards` when packaged.
`loadBoard` re-reads on every call, so a file edit is picked up on the next
launch.

## Board id resolution

Open project's `boardId` → persisted last-used id → named default
(`thinknode-m9-v1.0`) → the sole-`*.board.json` heuristic. Adding a second board
file does not flip the default out from under the M9's tests.

## Shipped boards

| File | Board | Notes |
|---|---|---|
| `boards/thinknode-m9-v1.0.board.json` | ThinkNode M9 V1.0 | 9 parts · 12 nets · 31 GPIO. ESP32-S3-R8 (octal PSRAM), 16 M flash. Every SPI peripheral on one shared bus. |
| `boards/heltec-wireless-paper-v1.1.board.json` | Heltec Wireless Paper v1.1 | Plain ESP32-S3, 8 M flash, **no PSRAM**. Radio and display on **separate SPI buses** (first two-SPI-bus board). Pin map from the checkout's own `variants/heltec_wireless_paper/platformio.ini`. |

## Board picker

A status-bar `<select>` switches boards without a restart (`board:list` IPC;
`key={board.id}` on `<App>` forces a clean remount). Not yet: persisting the
choice across launches, a native `View → Board` menu.

## Project file

`.pinbench` (`src/shared/project.ts`) — board id, PlatformIO dir + env, per-part
Inspector config, selected part. Save / Save as… (`⌘S` / `⇧⌘S`); the most recent
file is reopened on launch, re-adopting its PlatformIO checkout. Recents in
`session.json`. Tolerant on read (`normaliseProject`).
