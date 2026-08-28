# PinBench

A cross-platform desktop workbench for embedded mesh-radio boards. PinBench
emulates the board, runs your **real firmware binary** under emulation, and
gives every peripheral on it a panel you can configure, stimulate and observe —
plus a wiring canvas that generates the board's pin-map header, and a serial
console.

First target board: **ThinkNode M9 V1.0** (ESP32-S3-R8) running MeshCore.
Second: **Heltec Wireless Paper v1.1**.

[`ROADMAP.md`](ROADMAP.md) is the plan of record; every milestone there is a
vertical slice you can launch and look at.

## Where the project is

**M0 is done** — the emulation bridge was measured, and
[ADR 0001](docs/adr/0001-device-model-boundary.md) records the verdict: device
models are TypeScript, and the axis that matters is per-byte versus batched, not
C versus TypeScript.

**M1 is done** — this repository is the application shell: the window, the
Nocturne design system, the panels, the menus and the canvas, driven by fixture
data with no emulator behind it. Nothing here executes firmware yet. Buttons
whose milestone has not landed are drawn and disabled rather than omitted, so
the shell can be read against the design without pretending to do more than it
does.

## Running it

```sh
npm install
npm run dev     # Vite dev server with hot reload
npm start       # build, then run the built app
```

Node 22 or newer.

## Working on it

```sh
npm run typecheck   # both TypeScript projects (main/preload, renderer)
npm run lint
npm run format      # add :write to fix
npm test            # Vitest, jsdom
npm run build
npm run check       # everything above, in the order CI runs it
```

CI runs the same checks on macOS, Linux and Windows for every pull request.

## Layout

```
src/main/       Electron main process: window, native menu, session persistence
src/preload/    The only bridge out of the sandbox (contextBridge)
src/shared/     Types and pure logic both processes use — board definitions,
                workspace state, the command table, the IPC contract
src/renderer/   React + Vite renderer: the shell, the panels, the canvas
test/           Vitest setup and the fake preload bridge
docs/adr/       Architecture decision records
spike/          The M0 emulation spike (QEMU devices, bench firmware, results)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the conventions these follow and why.
