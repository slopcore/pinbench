# PinBench

A cross-platform desktop testbed for embedded hardware. PinBench
configures and simulates the **hardware**: it emulates the board, runs your
**real firmware binary** under emulation, and gives every peripheral on it a
panel you can configure, stimulate and observe. It also has a wiring canvas
that defines the board's pin map, and a serial console.

Code lives in your IDE. PinBench builds the PlatformIO folder you open but never
edits it. What the firmware must change to match the hardware is reported in the
**Firmware actions** dock tab, the `firmware_actions` MCP tool and
`.pinbench/actions.md`, so a coding agent in the IDE can act on it. See
[`docs/features/firmware-actions.md`](docs/features/firmware-actions.md).

Boards are data (`boards/*.board.json`), so any ESP32-S3 or ESP32-C6 design can
be described. Shipped so far: **ThinkNode M9 V1.0**, **Heltec Wireless Paper
v1.1**, **Waveshare ESP32-S3-ETH** (+ GC9A01 LCD and TWN4 RFID reader) and
**Waveshare ESP32-C6-Touch-LCD-1.28**. The first targets ran MeshCore, but
nothing in PinBench is specific to it.

The [`docs/`](docs/index.md) vault documents what PinBench does, feature by
feature. [`docs/status.md`](docs/status.md) tracks what is done, blocked and
next.

## Where the project is

PinBench boots real firmware under emulation today: it builds an image from a
PlatformIO checkout, runs it on an emulated ESP32-S3 or ESP32-C6, and drives
the board's displays, radios, Ethernet, touch and input parts from TypeScript
device models. The device-model plugin API, board definitions as data, pin-map
verify/codegen, and an agent control plane are all in — see
[`docs/status.md`](docs/status.md).

## Running it

```sh
npm install
npm run dev     # Vite dev server with hot reload
npm start       # build, then run the built app
```

Node 22 or newer.

## Packaging (macOS, Apple Silicon)

```sh
bash scripts/setup-emulator.sh   # once: builds the patched QEMU into .qemu/
npm run dist:mac                 # → release/dist/PinBench-<version>-arm64.dmg
npm run release:mac              # same, notarized (needs the setup below)
```

**Releases are cut manually**: Actions ▸ **Release** ▸ Run workflow (choose a
patch / minor / major bump), or `gh workflow run release.yml -f bump=minor`. It
collects every commit on `main` since the last `v*` tag, builds the signed and
notarized `.dmg`, and publishes a GitHub Release with grouped notes
(`build/release.ts`; Conventional Commit prefixes pick the section).

`scripts/bundle-qemu.mjs` copies the patched QEMU binaries into the app, along
with the Homebrew dylibs they link against and the ESP ROMs. It rewrites the
library paths so the app runs on a Mac without Homebrew. PlatformIO is not
bundled; the packaged app finds it through your login shell's `PATH`.

Signing uses a **Developer ID Application** certificate from the keychain (Xcode
▸ Settings ▸ Accounts ▸ Manage Certificates); without one the build is ad-hoc
signed. Notarization reads the `pinbench-notary` keychain profile:

```sh
xcrun notarytool store-credentials pinbench-notary \
  --key ~/.appstoreconnect/AuthKey_<KEYID>.p8 --key-id <KEYID> --issuer <ISSUER-UUID>
```

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

## Licence

MIT — see [`LICENSE`](LICENSE). The QEMU patches in `qemu/` and `spike/qemu/` are
GPL-2.0-or-later, like QEMU ([`qemu/README.md`](qemu/README.md#licence)). The
packaged app bundles QEMU and its libraries; their notices ship inside it at
`Contents/Resources/qemu/NOTICES.md`.
