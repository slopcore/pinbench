# PinBench

A cross-platform desktop workbench for embedded mesh-radio boards. PinBench
emulates the board, runs your **real firmware binary** under emulation, and
gives every peripheral on it a panel you can configure, stimulate and observe —
plus a wiring canvas that generates the board's pin-map header, and a serial
console.

First target board: **ThinkNode M9 V1.0** (ESP32-S3-R8) running MeshCore.
Second: **Heltec Wireless Paper v1.1**.

The [`docs/`](docs/index.md) vault documents what PinBench does, feature by
feature. [`docs/status.md`](docs/status.md) tracks what is done, blocked and
next.

## Where the project is

PinBench boots real firmware under emulation today: it builds a MeshCore image
from a PlatformIO checkout, runs it on an emulated ESP32-S3, and draws the M9's
real LCD output in a peripheral panel. The device-model plugin API, board
definitions as data, pin-map verify/codegen, and an agent control plane are all
in. The live radio demo is blocked on a QEMU-fork GPIO fault — see
[`docs/status.md`](docs/status.md).

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
docs/           Feature docs (Obsidian vault), ADRs, device-authoring guide
qemu/           PinBench's patches to the espressif/qemu fork
spike/          The M0 emulation spike (QEMU devices, bench firmware, results)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the conventions these follow and why.
