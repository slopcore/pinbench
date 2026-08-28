# PinBench — Roadmap

PinBench is a cross-platform desktop workbench for embedded mesh-radio boards. It
emulates the board, runs your **real firmware binary** under emulation, and gives
every peripheral on it a panel you can configure, stimulate and observe — plus a
wiring canvas that generates the board's pin-map header, and a serial console.

First target board: **ThinkNode M9 V1.0** (ESP32-S3-R8) running MeshCore.
Second: **Heltec Wireless Paper v1.1**.

---

## Locked decisions

These were settled before the roadmap was written. Everything below follows from them.

| # | Decision | Chosen | Consequence |
|---|----------|--------|-------------|
| 1 | Simulated or real hardware | **Simulated first** | No board on the desk is needed to develop or demo any milestone. Real USB flashing is out of scope for v1. |
| 2 | Simulation fidelity | **Full ESP32-S3 emulation** | The binary PinBench runs is the binary the board would run. Peripheral models are register-level, not behavioural mocks. |
| 3 | Where the binary comes from | **PinBench drives PlatformIO** | The app detects/bootstraps `pio`, generates the pin-map header from the canvas, builds the firmware, and boots the result. Canvas edits really do change what executes. |
| 4 | Board scope | **General workbench, modular devices** | Every board and every device is a self-contained module loaded from data. M9 ships first, Heltec Wireless Paper second — as data plus device models, not as a fork. |
| 5 | Device-model boundary | **TypeScript over a batching bridge** — settled by M0 | Device models are TypeScript; native C is reserved for bus controllers and the bulk transfer hook they need. The measurements are in [ADR 0001](docs/adr/0001-device-model-boundary.md): the axis that matters turned out to be per-byte vs batched, not C vs TypeScript. |
| 6 | Desktop stack | **Electron + TypeScript** | PinBench supervises long-running child processes (QEMU, PlatformIO) and may host device models in-process. That is Node's home turf; Tauri would push models into Rust or a sidecar. |
| 7 | Platforms | **macOS first, portable code** | Develop and package for macOS. Keep every path, binary lookup and device-naming assumption platform-agnostic. Windows and Linux are a discrete later milestone, not an afterthought bolted on. |
| 8 | Posture | **Serious OSS project** | Device models get a test harness and a documented plugin API from the moment the API exists. CI from M1. Contributor docs are a deliverable, not a nice-to-have. |

## Non-goals for v1

Naming these now so they stop coming up.

- **Flashing real hardware over USB.** The design draws it; v1 does not do it. "Build & flash" means "build and boot in the emulator".
- **Emulating the ESP32-S3's own WiFi and BLE.** Espressif's QEMU fork does not implement the wireless peripherals, and writing them is a project in itself. This matters concretely (see the risk register): the M9's *mesh* radio is an external LR1110 on SPI and is fully emulable, but MeshCore's `companion_radio` BLE transport is not, and the Heltec weather-station fork's WiFi fetch is not.
- **Schematic capture or PCB export.** The canvas is a pin-map and net editor, not an EDA tool. No netlist export, no footprints, no ERC beyond pin-assignment rules.
- **Cycle-accurate timing.** Peripheral models aim for functional correctness and plausible ordering. Code that depends on exact instruction timing will not behave identically.
- **A public device-plugin marketplace.** The plugin API is documented and stable-ish; distribution of third-party devices is out of scope.

## How to read the milestones

Each milestone is a **vertical slice**: it ends with something you can launch and
show, not a layer that only makes sense once the next layer lands. They are
ordered so that the riskiest unknown is retired first and the visually
compelling payoff (real firmware pixels on screen) arrives before the long tail
of peripheral work.

Every milestone states:

- **Goal** — the one sentence that justifies the slice.
- **Build** — the work.
- **Done when** — an observable, demonstrable condition. If you cannot demo it, it is not done.
- **Watch for** — the thing most likely to go wrong.

Sizes are rough relative effort (S / M / L / XL), not calendar estimates.

---

# Phase 0 — De-risk

## M0 · Spike: measure the emulation bridge — `XL` ✅ **done**

**Goal.** Answer the one question the entire architecture rests on — where device
models live — with numbers instead of an opinion.

This milestone produces throwaway code and one document. Resist the urge to make
it pretty; its output is a decision.

**Build**

1. Build [`espressif/qemu`](https://github.com/espressif/qemu) with the `esp32s3`
   target on macOS. Record the exact fork, tag and configure flags in the ADR —
   this pin is load-bearing for every later milestone.
2. Boot something trivial first: an ESP-IDF `hello_world` image. Confirm UART0
   output reaches your terminal. Do not proceed until this is boring.
3. Boot a **MeshCore `simple_repeater` build** for a generic ESP32-S3 target.
   Expect it to fail or hang partway — that is fine and informative. Record how
   far it gets and what it was waiting on.
4. Implement the cheapest possible **bridge device**: a QEMU device model that
   claims one SPI host and forwards every transaction over a Unix domain socket
   to a Node process, which replies with response bytes.
5. **Measure**, and this is the whole point of the milestone:
   - Round-trip latency for a single 1-byte SPI transaction over the bridge.
   - Throughput for a full 320×240×16bpp framebuffer flush — **153,600 bytes** —
     which is what the ST7789 will actually do, repeatedly, in M6. Compare
     against the same flush handled natively inside QEMU.
   - The same for a bulk `write`-style transfer where the bridge can batch
     rather than round-trip per byte.
6. Write `docs/adr/0001-device-model-boundary.md` recording the measurements and
   the decision.

**The decision to make.** Three viable shapes, and the numbers pick between them:

- **TS over the bridge** — every device is a TypeScript module implementing a
  transaction interface. Hot-reloadable, testable without QEMU, trivial to
  contribute. Viable only if bulk transfers batch well.
- **Native C in the fork** — best fidelity and timing, worst modularity, and
  contributors need a QEMU dev environment.
- **Hybrid** — bus controllers and any device with a hot bulk path (the display)
  in C; everything else (sensors, RTC, GNSS, buttons, expansion parts) in TS.
  This is the outcome I expect the numbers to favour, but the point of the spike
  is not to assume it.

**Done when.** The ADR is committed, contains real measured figures, and names
the chosen boundary. A second person could read it and understand why.

**Watch for.** ESP32-S3 support in the Espressif fork is real but not complete —
PSRAM emulation in particular is limited, and the M9 has 8 MB of it. Find out in
this milestone whether MeshCore needs PSRAM to boot, because if it does, that is
a blocker to solve here and not a surprise in M6.

### Outcome

Full write-up in [ADR 0001](docs/adr/0001-device-model-boundary.md); the code
that produced it is in [`spike/`](spike/). The headline numbers, per
153,600-byte frame:

| Device model | ms per frame |
|---|---|
| TypeScript, whole frame in one round trip | **0.62** |
| Native C, one byte at a time through `ssi_transfer()` | **3.91** |
| TypeScript, one byte at a time | **7,712** |

**The decision: device models are TypeScript, including the display.** The
expected answer — display in C because it is hot — is wrong by a factor of six.
Batching is worth ~12,000×; rewriting in C is worth ~6×, and only once batching
exists. So the boundary moved from *device* to *bus*: bus controllers are C in
the fork, they hand device models whole buffers, and everything else is
TypeScript.

Four findings that change later milestones:

- **SPI2 and SPI3 do not exist in the fork.** Only SPI1 (flash/PSRAM) is
  modelled. Every M9 peripheral — LR1110, ST7789, microSD — is on SPI2/SPI3, so
  writing those controllers is a prerequisite for M6 and M8, not a detail
  inside them. This is the single largest piece of unplanned work the spike
  found.
- **PSRAM is not a blocker.** 8 MB works, verified by allocation and read-back.
  Octal parts like the M9's ESP32-S3-R8 need `-global ssi_psram.is_octal=true`,
  and `-m` must be passed at all or there is silently no PSRAM. Risk retired.
- **Firmware must be built DIO, not QIO.** QEMU's flash model has no QPI
  commands; a QIO build boot-loops with an assert in
  `esp_vfs_console_register()` that points nowhere near the cause. M3 must set
  this and explain it.
- **MeshCore boots the SoC and stalls in peripheral bring-up**, blocked (not
  spinning) before its first serial output, waiting on the SPI peripherals that
  do not yet exist. Exactly the expected failure, and it un-blocks as M6 and M8
  land.

---

# Phase 1 — Something you can look at

## M1 · Application shell and the Nocturne design system — `L` ✅ **done**

**Goal.** The window from the design, rendered, navigable, and running in CI —
driven by fixture data, with no emulator behind it.

**Build**

- Electron + TypeScript + Vite + React. Strict TS. Renderer sandboxed, context
  isolation on, all privileged work behind a typed preload bridge — establish
  this now, because retrofitting it after the emulator lands is miserable.
- **Nocturne tokens as CSS custom properties**, transcribed from the design:
  ground `#161826`, surface `#232532`, accent `#9184d9` with the full 100–900
  ramps for neutral, accent and accent-2. Inter and JetBrains Mono bundled
  locally, not fetched. 12.5px base.
- Layout skeleton: 40px title bar, 34px toolbar, three-column body (Library 226px
  / workspace / Inspector 286px), resizable bottom dock.
- Working chrome: File/Edit/View/Build/Help menus with the items and shortcuts
  from the design, hover-to-switch behaviour, click-outside to dismiss. Panel
  toggles (`⌘1` Library, `⌘2` Inspector, `⌘3` Source) genuinely toggle.
- Workspace tabs (Diagram / Source) and dock tabs (Serial monitor / Diagnostics)
  switch and persist across restarts.
- Canvas: pan, zoom, Fit, the dot/line/none grid, and the tool buttons rendered
  (Select and Pan functional; Draw net and Probe pin present but inert).
- CI from this commit: typecheck, lint, unit tests, and a build on every PR.

**Done when.** `npm start` opens a window that a stranger would mistake for the
design. Every panel toggles, the canvas pans and zooms, layout survives a
restart, and CI is green.

**Watch for.** Do not let fixture data leak into component signatures. Everything
displayed should already arrive through the shape a real board definition will
later provide, or M5 becomes a rewrite.

---

# Phase 2 — Real firmware, really running

## M2 · Boot a binary and see its serial output — `L` ✅ **done**

> M0 already proved this path end to end from the command line: Arduino
> firmware for `esp32-s3-devkitc-1` boots under `-machine esp32s3` and prints
> on UART0. M2 is about putting a supervised process and a UI around it, not
> about discovering whether it works.

**Goal.** The first honest end-to-end slice: open a firmware image, and watch
MeshCore's actual boot log scroll in the dock.

**Build**

- **Emulator supervisor** in the main process: locate the QEMU binary, spawn it
  with the machine/flash arguments, stream stdout/stderr, handle crashes and
  non-zero exits, and guarantee the child dies with the app. This is
  infrastructure that everything after M2 leans on — give it a real state
  machine (`idle → starting → running → stopping → crashed`) and tests.
- **File ▸ Open firmware image…** takes a `.bin` (or a PlatformIO `.pio/build/<env>/`
  directory) and boots it.
- UART0 out is piped to the **Serial monitor** dock: monospace, timestamped from
  emulator start, ANSI colour stripped, autoscroll with scroll-lock on manual
  scroll, a bounded ring buffer so a chatty firmware cannot exhaust memory.
- Serial **input**: type in the dock, bytes reach the firmware's UART. MeshCore's
  `simple_repeater` CLI is live from boot, so `ver` should answer.
- Run controls: Start / Stop / Reset, plus emulator state in the title bar.
- Ship the QEMU build as a per-platform prebuilt binary fetched or vendored at
  install time. Pin the version. Verify a checksum.

**Done when.** You open a MeshCore image, the boot banner appears in the dock,
you type `ver`, and the firmware answers. Nothing about the board is modelled
yet — that is the next phase — but the CPU is genuinely executing your firmware.

**Watch for.** MeshCore may not reach its CLI without the peripherals it probes
at boot. Expect to add crude always-ACK stubs for I2C/SPI here just to get past
`setup()`. That is acceptable scaffolding; note each stub so M4 onward replaces
it deliberately rather than by accident.

## M3 · Build the firmware from inside PinBench — `L` ✅ **done**

**Goal.** Close the loop from source to running emulator without leaving the app.

**Build**

- **PlatformIO integration**: detect `pio` on `PATH`, in a venv, or beside the
  bundled interpreter; if absent, offer a guided bootstrap into an app-managed
  virtualenv. (Your MeshCore notes already document this exact pain on macOS
  with an externally-managed Python — encode that knowledge here so nobody
  rediscovers it.)
- **Open project**: point PinBench at a MeshCore checkout. Parse `platformio.ini`,
  list environments, let the user pick one.
- **Build & flash** runs `pio run -e <env>`, streams output to the Diagnostics
  dock live, and on success hands the artifact to M2's runner and boots it. The
  button cycles `Compiling… → Linking… → Flashed ✓` exactly as designed — the
  labels are now telling the truth.
- **Parse compiler diagnostics** into the structured rows the design shows:
  severity, message, `file:line`. Clicking a row opens that file in the Source
  tab at that line.
- **Source tab**: file tree over the real project, syntax-highlighted read-only
  viewer, dirty indicators from filesystem watching.
- **Force DIO flash mode for emulator builds**, and say so in the UI. QEMU's
  flash model implements no QPI commands, so a stock QIO build boot-loops with
  an assert inside `esp_vfs_console_register()` — an error that points nowhere
  near the cause. Override `board_build.flash_mode` and
  `board_build.arduino.memory_type` for the emulator target, and surface the
  override rather than hiding it. (M0 lost an hour to this.)
- **Pass PSRAM options through from the board definition**: `-m <size>`, plus
  `-global ssi_psram.is_octal=true` for octal parts such as the M9's
  ESP32-S3-R8. Without `-m` there is silently no PSRAM at all.
- Cache builds; make an unchanged rebuild near-instant.

**Done when.** Open a MeshCore checkout, hit **Build & flash**, watch it compile,
and see the freshly built firmware boot in the serial dock. Introduce a
deliberate syntax error and the failure appears as a clickable diagnostic.

**Watch for.** First builds are slow (toolchain download plus a cold framework
build) and will look like a hang. Show real progress from the first second.

### Outcome

Build & flash runs `pio run` and an in-app port of `mkflash.sh` end to end and
boots the result. Verified against a real PlatformIO project with the actual
`pio` 6.1.19 and `esptool` 4.5.1: `preparing → compiling → linking → merging →
done`, an 8 MB merged image, and the freshly built firmware printing on UART0
under `-machine esp32s3`. MeshCore itself was not the subject — no checkout was
available — but the loop is firmware-agnostic.

- **`pio` discovery** mirrors `findQemu`: `PINBENCH_PIO` env → repo `.pio-venv/`
  → an app-managed venv under `userData` → `PATH`. `scripts/preflight.mjs` now
  checks the same order instead of only `PATH` (it was warning falsely).
- **The DIO override never touches the user's `platformio.ini`.** `pio run`
  6.1.19 has no `--project-option`, so PinBench writes its own `-c` config that
  pulls the user file in via `extra_configs` and pins
  `board_build.flash_mode = dio` / `memory_type = dio_qspi` per environment.
  Round-tripping into their file is the M11 mistake; it does not start here.
- **Process-group kill.** `pio run` spawns scons children; the build spawns
  `detached` and cancel sends `SIGTERM` to `-pid` (`taskkill /T` on Windows).
  The runner is disposed on `before-quit` alongside the emulator.
- **Carriage-return progress** is handled by a `LineStreamer` that surfaces a
  bare `\r` as a *replace* segment, so the toolchain-download minutes the
  milestone warns about render as one updating line, not a dead UI.
- **Diagnostics** are parsed from the transcript (`file:line:col: severity:
  message`), resolved to absolute paths in the main process, sorted worst-first,
  and clickable through to the Source tab at the line. Linker errors and framing
  noise stay in the raw log rather than being forced into rows.
- **Caching.** PlatformIO's own incremental build makes an unchanged
  PinBench→PinBench rebuild ~1 s; on top of that the merge step is skipped when
  the image is newer than `firmware.bin` and nothing recompiled (`cached:
  true`). Because the `-c` override changes PlatformIO's project checksum, a
  user who alternates between their own bare `pio run` and Build & flash gets a
  full rebuild each way — acceptable, and the price of not editing their file.
- **Board-derived emulator options.** `EmulatorSupervisor.start` no longer
  hardcodes `-m 8M`; `BoardDefinition.emulator` (`machine` / `psramSize` /
  `psramOctal`) travels from the board through the renderer to the launch args.
- **Source tab** is now real: a lazy file tree read over IPC (confined to the
  project root, `.pio`/`.git`/`node_modules` pruned), a read-only viewer with a
  dependency-free C/C++/INI highlighter, and dirty markers from a recursive
  `fs.watch` (which simply no-ops on Linux).
- The toolbar's **Build & flash** button and the ▶ ■ ⟳ emulator controls —
  drawn but inert since M1 — are now wired.

---

# Phase 3 — The device architecture

## M4 · Device plugin API and first device — `L` ✅ **done**

**Goal.** Turn the M0 decision into the API every future device is written
against, and prove it with something small enough to eyeball.

**Build**

- **`DeviceModel` interface**, in TypeScript, as M0 decided. It needs: lifecycle
  (`attach`/`reset`/`detach`), bus transaction handlers for the buses the device
  sits on, a serialisable state snapshot, an event stream out (for OUT panels),
  a command surface in (for IN panels), and declared metering values.
- **The interface is transaction-shaped, never byte-shaped.** A handler receives
  a whole buffer and returns a whole buffer. This is the load-bearing
  consequence of [ADR 0001](docs/adr/0001-device-model-boundary.md): a socket
  round trip costs tens of microseconds, so a per-byte interface makes a display
  flush take 7.7 seconds. Retrofitting batching later is the mistake this rule
  exists to prevent. Budget by *transaction count*, not byte count.
- **The bulk hook in QEMU.** `ssi_transfer()` is per-byte by construction, so
  the C side needs a bulk path alongside it that hands a device model an entire
  transaction in one call. It is new code with no upstream equivalent and it is
  on M6's critical path.
- **Measure the real protocol's framing overhead** once it exists and amend the
  ADR. M0's numbers moved raw bytes behind a five-byte header; they are a floor,
  not a promise.
- **Decide the blocking-model failure policy.** A model that hangs hangs the
  vCPU. Pick a timeout, and pick what the guest and the UI see when it trips.
- **Device registry**: models are discovered and instantiated by id from a board
  definition. Adding a device means adding a module and referencing it — never
  editing a central switch statement.
- **Test harness**: exercise a device model against scripted bus transactions
  with no QEMU and no Electron in the loop. This is the single highest-leverage
  thing in the project. Every subsequent device milestone lands with tests
  because the harness makes it the path of least resistance.
- **First device: an LED on a GPIO.** Trivially verifiable, exercises the entire
  path, and gives you a visible artefact within a milestone.
- **`docs/devices/authoring.md`** — write it now, while the API is small enough
  to describe honestly.

**Done when.** Firmware toggling a GPIO makes a rendered LED blink in its OUT
panel, the LED model has unit tests that run without QEMU, and the authoring doc
is good enough for someone else to add a second device from it.

**Watch for.** The temptation to design the API around the LED. Sketch the LR1110
(M8) and ST7789 (M6) against the draft interface before committing — they are
the two devices most likely to expose a missing concept, and finding that here
costs a day rather than a refactor.

### Outcome

The device plugin API is in and exercised: a `DeviceModel` interface, a
self-registering registry with no central switch, a QEMU-free test harness, the
main-process device host with a defined failure policy, the real wire protocol,
and an LED model with rendering in its OUT panel. What M4 could not do live —
and why — is spelled out below in the tone of M3's "MeshCore itself was not the
subject".

- **`DeviceModel` is transaction-shaped from line one.**
  `src/shared/devices/model.ts`: lifecycle (`attach`/`reset`/`detach`),
  `onBus(txn) → BusResponse` taking and returning whole buffers, `onSignal` for
  digital lines, `onCommand` for IN panels (M7), `snapshot()`, and declared
  `meters`. There is no byte-level entry point to retrofit batching onto — the
  mistake [ADR 0001](docs/adr/0001-device-model-boundary.md) exists to prevent.
- **The registry has no switch statement.** A model file exports a
  `DeviceModelDescriptor`; `src/shared/devices/builtin.ts` lists the files; the
  board references models by id. An id with no registered model is a *visible
  no-op* — the host reports it once and leaves the part inert — so the M9's
  nine `deviceModel` ids load fine with only `pinbench.led` implemented.
- **The test harness is the path of least resistance.**
  `src/shared/devices/harness.ts` drives a model with scripted transactions and
  edges, a virtual clock, and recorded events/diagnostics/driven-lines, with
  no QEMU and no Electron imported. `led.test.ts` is the worked example the
  authoring doc points at.
- **Failure policy (ADR open question 4).** Models are synchronous by contract;
  the host cannot preempt a real infinite loop without hanging itself, so the
  backstop for a hung guest is the C-side socket read timeout the SPI
  controller gets in M6. Host-side: a model that throws is quarantined (bus
  replies become all-`0xFF`, never silent zeros — M8's rule — plus a named
  `error` diagnostic) until `Reset`; a call over 50 ms raises a one-shot
  `warn`; a wrong-length reply is padded/truncated with a diagnostic.
- **Wire protocol and framing overhead (ADR open question 3).**
  `src/shared/devices/protocol.ts`: a 20-byte fixed header (magic, op, flags,
  bus index, select, seq, 64-bit-range ns timestamp, length) then payload,
  little-endian, with a streaming `FrameDecoder`. `scripts/bench-framing.mjs`
  measures it: ~4 µs to encode+decode a full 153,600-byte frame (under 1% of
  the spike's 0.62 ms bridge figure), ~110 ns for a 1-byte transaction. The
  ADR is amended with the table. `DeviceHost` implements the listening socket
  and `handleFrame` dispatch, and both are unit-tested over a real Unix socket
  in `devices.test.ts` — but nothing calls `host.listen()` in the running app
  yet, because there is no QEMU client to connect until M6 builds the SPI2/SPI3
  controllers. The seam exists; M6 picks a socket path and connects to it.
- **A first macOS latency number (ADR open question 1).** The same script
  clocks a Unix-domain-socket round trip on the dev Mac at **~5 µs**, against
  the spike's 48–64 µs on Linux. It is a standalone socket bench, not a re-run
  of `spike/run-bench.sh` through a live guest, so the risk-register row stays
  open for M6 — but Darwin's IPC is *faster* here, so the per-transaction
  budget is a conservative ceiling on the target platform, not an optimistic
  one.
- **The LED, and the honest gap.** `pinbench.led` is an active-high/-low LED on
  a GPIO with edge, duty-cycle and event outputs, unit-tested without QEMU, and
  rendered as a bulb in the Inspector's OUT panel. The roadmap's "firmware
  toggling a GPIO" half is **not wired**, because the espressif fork's GPIO
  peripheral is a stub — `esp32_gpio_write()` is empty and output state is not
  modelled at all, the same "the fork models SPI1 only" class of gap M0 found.
  Feeding real GPIO edges needs the output/`W1TS`/`W1TC` registers implemented
  in C plus an observation hook. That is now an explicit **M6 Build bullet**
  ("GPIO output in the fork") and a risk-register row, because the ST7789's own
  `DC`/`RST`/`BL` lines need the same code — it is on M6's critical path, not a
  loose end. Until then the OUT panel's **Drive high / Drive low** control
  drives the line so the render path is demonstrable end to end; every edge is
  timestamped so the log stays honest about where it came from.
- **The bulk hook in `ssi_transfer()`** is likewise M6's — nothing in M4 needed
  it, since the LED is on a GPIO and the interface contract is what M4 owed. M6
  now carries it as a named Build bullet next to the SPI controllers, and the
  M4 socket transport it will feed has an M6 bullet and a risk-register row for
  the wiring that is still owed.
- **`docs/devices/authoring.md`** is written, and includes the M4 "watch for":
  the LR1110 and ST7789 sketched against the interface. Neither needs a concept
  it lacks — a transaction whose meaning depends on a separate line (`DC`), a
  bulk-pixel snapshot, an output line with real timing (`BUSY`), and a meter
  derived from earlier transactions all fit.
- **Renderer + IPC.** `PinBenchApi.devices` (load, `onSnapshot`, `onEvent`,
  `onDiagnostic`, `command`); `useDevices` fans snapshots to the OUT panels and
  device diagnostics into the Diagnostics dock. The M9 fixture gains a demo
  `Status LED` part (GPIO45); it is deleted with the fixture at M5.

## M5 · Board definitions, and the M9 as data — `M` ✅ **done**

**Goal.** Nothing about a board is hardcoded. The M9 becomes the first entry in
a format the Heltec board will later use unchanged.

**Build**

- **Board definition schema** (JSON or TS module, validated): board identity and
  MCU target, the full pin list, bus declarations (SPI0 with its SCK/MOSI/MISO,
  I2C0, I2C1, UART1), parts with their pin bindings and device-model ids, nets
  with bus membership and labels, plus canvas layout hints and the per-part
  config fields the Inspector renders.
- **The M9 definition**, transcribed from the design: nine parts — CH340K
  USB-UART, LR1110, 2.4" LCD, ESP32-S3-R8, microSD, ATGM336H GNSS, the I2C
  sensor cluster, the ESP32-S2 keyboard coprocessor, power and buzzer — with the
  real pin map (`M9_SPI_SCK` 40, `MOSI` 47, `MISO` 38, `LR_NSS` 39, `LCD_CS` 16,
  `SD_CS` 48, `I2C` 7/6, and the rest).
- Canvas, Library and Inspector all render **from the definition**. Delete the
  M1 fixtures entirely.
- **Project file** (`.pinbench`): which board, which firmware project, canvas
  layout, per-part config, window state. Open/save/recent.

**Done when.** The M9 canvas comes up from a definition file; editing the file
changes what the app shows; no board-specific identifier survives anywhere in
`src/` outside the definition.

**Watch for.** Over-generalising. One board and one planned second board is not
enough evidence for a deeply abstract schema. Model what the M9 and the Heltec
board actually need; leave the rest.

### Outcome

The M9 is now `boards/thinknode-m9-v1.0.board.json`, read with `fs` and
validated at launch; the M1 fixtures are gone. Verified: `npm run dev` builds
main + preload + renderer and Electron launches clean; `loadBoard()` discovers
and validates the shipped file through the same `parseBoard` the app uses
(`src/main/board.test.ts`), and `boardTotals` on it reads `9 parts · 12 nets ·
31 GPIO` — the design's footer figure, which `App.test` confirms the StatusBar
renders. Because `loadBoard` re-reads the file on every `board:load`, an edit is
picked up on the next launch, the same standard as M2/M3's firmware path. No production file under `src/`
names a board: `loadBoard()` with no id discovers the sole `*.board.json` on
disk, `.pinbench`'s `boardId` defaults to `''` ("the workbench default"), and
the only `thinknode` strings left in `src/` are in `.test.ts` files that load
the shipped definition — the same way `Canvas.test` and `App.test` have always
referred to the M9 by name.

- **`parseBoard` in `src/shared/board.ts`** is the schema, and it fails loud
  (`BoardValidationError` with the offending field path) rather than coercing —
  the opposite of `normaliseWorkspace`/`normaliseSession`, because a
  silently-mangled pin map is the "silent zeros cost you days" trap the device
  milestones warn about. It enforces the four cross-reference checks that were
  assertions stranded in the M1 fixture's test file: part pins resolve to
  declared pins, part buses and net buses exist, net `partId:signal` endpoints
  resolve to a real signal, and there is exactly one `mcu` part. Loading the
  shipped M9 in a test therefore *is* a consistency check.
- **Loading moved to the main process.** M4's `device:load` (renderer → main,
  handing over a board it had `import`ed) is gone; `board:load` runs the other
  way — `src/main/board.ts` reads and validates the file, hands the parsed
  definition straight to `DeviceHost`, and returns it to the renderer over IPC.
  The sandboxed renderer never touches a board file. `boardsDir()` is the repo
  root in dev and `resourcesPath/boards` when packaged; wiring the packaged
  copy is an M15 detail. One consequence of the inversion: the host loads
  models during the `board:load` call, before the renderer's device
  subscriptions are live, so the one-shot "no model … part is inert"
  diagnostics for the M9's nine unimplemented ids no longer reach the dock on
  first load. They re-emit on any later `board:load` (reopening a project), and
  M6 — which wires `DeviceHost.listen()` and brings real snapshots — is where
  retained device state starts to matter.
- **The pin map was reconciled, not transcribed verbatim.** The M1 fixture
  invented seven signals that clashed with numbers this roadmap states for
  M7–M11 — `LR_NRESET` (→ GPIO45), I2C1 SDA/SCL (→ 20/21), `KEY_INT` (→ 12),
  GNSS UART1 (→ 2/3), 1PPS (→ 4), `GPS_EN` (→ 11), `BAT_ADC` (→ 13) — plus
  three non-stated collisions moved to free pins (LCD `BL` → 10, `USB_DET` → 8,
  `CHG_STAT` → 17). With the corrected map M7's deliberate `GPIO12` double-bind
  and M11's "move LCD_CS to GPIO21, collide with the keyboard's SCL" demo both
  work as written. Provenance — stated vs invented — is recorded in
  `boards/README.md`, since JSON carries no comments.
- **Totals now match the design.** `boardTotals` reads **9 parts · 12 nets · 31
  GPIO assigned**, the design's footer figure and M10's Done-when. The delta
  from M4's `10 · 12 · 32` is exactly the demo `Status LED` (`pinbench.led` on
  GPIO45), deleted with the fixture as the roadmap said it would be. That
  leaves the M9 with **no instantiated device model** — every one of its nine
  `deviceModel` ids is still a visible no-op — so M4's OUT-panel render path is
  no longer exercised by the running app (its unit tests still cover it). M6's
  ST7789 is the first model the M9 actually runs.
- **`.pinbench` project file** (`src/shared/project.ts`): board id, PlatformIO
  dir + env, per-part Inspector config, selected part. Save / Save as… are
  wired (`⌘S` / `⇧⌘S`, enabled in the menu spec), the most recent file is
  reopened on launch — re-adopting its PlatformIO checkout so the Source tab and
  Build & flash come back with it — and `File ▸ Open project…` now opens a
  `.pinbench` rather than a bare directory (the firmware checkout is attached
  from Build & flash). Recents live in `session.json` next to the window
  bounds; canvas pan/zoom and panel layout deliberately stay in the workspace
  store, not the project file — that split is M11/M12's to revisit. `.pinbench`
  files are tolerant on read (`normaliseProject`), like every other persisted
  layout file.

---

# Phase 4 — The payoff

## M6 · The display: ST7789, and real firmware pixels — `XL` 🚧 **in progress**

**Goal.** The moment PinBench justifies choosing full emulation. The LCD's OUT
panel shows the MeshCore home screen — not a lookalike drawn in TypeScript, but
the output of `ui_home.cpp`'s `draw()` running on an emulated Xtensa core.

**Build**

- **SPI2/SPI3 host controllers, in C, in the fork.** The espressif fork models
  SPI1 only — the flash and PSRAM controller. Every peripheral on the M9 sits on
  SPI2 or SPI3, so those controllers do not exist yet and nothing on this board
  can talk until they do. Register-level models, feeding the bulk hook below.
  This is the largest piece of work in the milestone and it is infrastructure the
  radio (M8) and microSD (M9) need too, so treat it as its own slice inside M6
  and land it first.
- **The bulk hook in `ssi_transfer()`.** ADR 0001's load-bearing consequence: a
  per-byte SSI API makes a display flush take seconds, so the C side needs a
  path that hands a device model an entire transaction in one call. M4 froze
  the transaction-shaped `DeviceModel.onBus` interface and did *not* build this
  — it is new QEMU code with no upstream equivalent and it lands here, with the
  SPI controllers, as the thing that makes them useful.
- **Wire the device host's socket.** `DeviceHost.listen()` and the frame
  protocol exist from M4 and are unit-tested over a real socket, but nothing in
  the app calls `listen()` because there was no QEMU client. M6 picks the
  socket path (under `userData`), passes it to QEMU as a launch arg alongside
  the PSRAM flags, and the SPI controllers — the first client — connect to it
  and round-trip transactions to the TypeScript models.
- **GPIO output in the fork.** `esp32_gpio_write()` is an empty stub — the fork
  models no GPIO output or enable state at all. The ST7789 cannot be driven
  without it (its `DC`/`RS`, `RST` and `BL_EN` lines are SoC GPIOs, and `DC`'s
  level *is* how a transaction is parsed), so the output/`W1TS`/`W1TC` registers
  plus an observation hook to the device host are on this milestone's critical
  path. Landing it here also retires M4's deferred "firmware toggling a GPIO
  blinks the LED" and unblocks M7's `KEY_INT` wake line, M10's `VDD_PERIPH` and
  buzzer, and M11's Probe-pin tool.
- **ST7789 device model**: command/parameter state machine, `MADCTL` orientation,
  `CASET`/`RASET` window addressing, `RAMWR` streaming, 16bpp and 18bpp colour,
  the reset and DC/RS lines, and `BL_EN` backlight state.
- **Framebuffer to canvas**: dirty-rect tracking, throttled to display refresh
  rather than per-transaction, rendered into the node's OUT panel at ½ / ¾ / 1:1
  zoom with the **BL ON/OFF** toggle dimming it, exactly as designed.
- **SPI bus arbitration**, the design's headline correctness feature: three
  devices share SCK/MOSI/MISO, and asserting two chip selects at once is a
  hardware fault. The bus model detects it and raises a diagnostic naming the
  offending selects — this is a real class of bug PinBench can catch that a
  scope on the bench would make you work for.
- Meters: flush time per frame, dirty-rect count, bus share.

**Done when.** Boot MeshCore, and the emulated 320×240 panel draws the home
screen — node name, clock, battery, channel list. Change `ui_home.cpp`, rebuild,
and the rendered screen changes.

**Watch for.** M0 measured a TypeScript display model at 0.62 ms per full frame
*provided the controller hands it whole buffers*. If flushes are visibly slow
here, the first suspect is not the model's language — it is a controller that is
still round-tripping per byte, or a firmware access pattern that produces many
small transactions instead of few large ones. Count transactions per frame
before rewriting anything in C.

### Progress

The MeshCore side is now known, not guessed: the M9 uses `DISPLAY_CLASS =
ST7789Display`, whose `ST7789Spi` driver talks to the panel one
`SPI.transfer(uint8_t)` at a time on **SPI2_HOST**, toggling the `DC` GPIO
around command vs. data, with chip-select a plain `digitalWrite` GPIO (not a
hardware SPI select). That shaped every decision below. Firmware is
`meshcore-dev/MeshCore` PR #2942 (merged), env `ThinkNode_M9_companion_radio_usb`
— no BLE, so nothing hits the WiFi/BLE non-goal.

**Landed and verified without QEMU (the TypeScript half — 218 tests green):**

- **`sitronix.st7789` device model** (`src/shared/devices/st7789.ts`,
  registered in `builtin.ts`). Transaction-shaped `onBus` — never a byte —
  interpreting each transfer against the current `DC` level fed by `onSignal`:
  a full command state machine (SWRESET/SLPOUT/DISPON/INVON, `COLMOD` 16/18bpp,
  `MADCTL`, `CASET`/`RASET` window, `RAMWR`/`RAMWRC` streaming with cursor wrap
  and MX/MY/MV scan order), a real 240×320 RGB565 GRAM, `RST`/`BL` lines with
  configurable polarity, and — M8's rule, one milestone early — a loud named
  diagnostic for any unimplemented command rather than a silent accept.
  `st7789.test.ts` walks the real MeshCore init sequence, a windowed `RAMWR`,
  the MV fast-axis swap, a split-across-transactions pixel, and a hardware
  reset.
- **The framebuffer travels in a side channel, not a snapshot.**
  `DeviceHost` JSON-stringifies every snapshot to dedupe it (devices.ts:534);
  a 153,600-byte GRAM through that, per `RAMWR`, is the exact failure ADR 0001
  exists to prevent, arriving via the host instead of the bus. So `snapshot()`
  is scalars only, and the host pulls `takeFrame()` on a ~30 fps timer and
  emits a `device:framebuffer` IPC message (RGB565 buffer + dirty rect +
  MADCTL). New `DeviceFramebufferMessage`, `IpcChannel.deviceFramebuffer`,
  preload `onFramebuffer`, and `useDevices` fan-out.
- **SPI selection is by observed GPIO, not a hardware CS.** New `Op.Gpio`
  frame (pin number in `select`, level in the payload). `DeviceHost` maps the
  pin to a part+signal through the board definition, tracks which SPI device's
  `CS` is low, routes each `Op.Xfer` to that device, and forwards `DC`/`RST`/
  `BL` edges as `SignalEdge`s. Two chip-selects low on one bus raises the
  named **bus-contention diagnostic** the roadmap calls for. `devices.test.ts`
  covers routing, contention and the framebuffer channel.
- **Meters**: flush-time-per-frame, dirty-rect count, transactions-per-frame
  (the number the "Watch for" says to check first), and bus-share — the last
  filled by the host, since a model only sees its own bytes.
- **OUT-panel render** (`St7789Screen.tsx`): the GRAM drawn to a `<canvas>` at
  native resolution, `MADCTL`-transposed to landscape, CSS-scaled to the
  Inspector's 1×/2×/3× zoom, dimmed when display or backlight is off.
- **`DeviceHost.listen()` is wired.** `src/main/index.ts` starts the host on a
  `userData` socket *before* any emulator spawn (the guest connects during
  QEMU realize and blocks on the first reply), and `EmulatorSupervisor` passes
  the path to the child as `PINBENCH_DEVICE_SOCKET`.
- **Board definition reconciled to the real M9 pinout** for the display path:
  `u3` `BL` → GPIO17 (`PIN_TFT_LEDA_CTL`), `TE` → GPIO19; `u9` `CHG_STAT`
  moved off the freed GPIO17.

**Landed and compile-verified only (the QEMU C half — builds and links clean
into the fork; not yet exercised by a live guest):**

- **GP-SPI2 / GP-SPI3 controllers** (`qemu/hw/ssi/pinbench_gpspi.c`). The fork
  models SPI1 (flash) only; these are the general-purpose `SPI_*` register
  layout that every M9 peripheral needs and that did not exist. Scoped to the
  Arduino FIFO path: `SPI_CMD.USR`/`.UPDATE` (self-clearing), `SPI_MS_DLEN`,
  `SPI_USER*`, `SPI_W0..W15`; unknown registers absorbed so clock/DMA/timing
  pokes read back and nothing faults.
- **The bulk hook.** On one `SPI_USR` pulse the whole FIFO window is handed to
  the device host in a single socket round trip — ADR 0001's "few large
  transactions, not thousands of small ones", realised in the controller
  rather than bolted on later.
- **GPIO output in the fork** (`qemu/hw/gpio/esp32_gpio.c`, a pinned
  replacement — `esp32_gpio_write` was `{ }` upstream). `OUT`/`OUT1`/`ENABLE`
  and their `W1TS`/`W1TC` aliases, with every level change forwarded as
  `Op.Gpio`. Retires M4's deferred "firmware toggles a GPIO → LED blinks".
- **The socket bridge** (`qemu/hw/misc/pinbench_host.c`): the M4 20-byte
  protocol (not the spike's 5-byte one), a lazy singleton keyed by
  `PINBENCH_DEVICE_SOCKET` (unset ⇒ every call a no-op, so a stock
  `qemu-system-xtensa` is unaffected), a Hello handshake, and the
  **socket-read timeout** the `devices.ts` header promised as the backstop for
  a hung model — after it, the guest sees `0xFF`, never silent zeros.
- **Instantiation**: `qemu/hw/xtensa/pinbench_esp32s3.c` maps the two
  controllers at `0x60024000` / `0x60025000`; `qemu/apply.sh` adds three meson
  lines and two lines to `esp32s3.c` (an include and one call after the GPIO
  controller realizes). `apply.sh` is wired into `npm run setup:emulator` with
  a `.pinbench-applied` marker for idempotency — the M6 answer to "the spike's
  patch dir is declared throwaway".

**Not reached this session, and why:**

- **A live MeshCore boot drawing the home screen** — the milestone's Done-when.
  At the time of this write-up the rebuilt `.qemu` binary appeared to produce no
  UART output; **M6.1 traced that to the app's launch arguments** (`-nographic`
  + `-monitor none -serial stdio` silently disconnects the UART — see M6.1's
  Outcome), not emulator bring-up. With `-serial mon:stdio` the M0 image boots
  and prints. Building the `companion_radio_usb` image
  through PinBench's `pio` path (16 MB partitions, the DIO `-c` override) and
  booting it, is M6's remaining work. Until then the GP-SPI register model,
  the `SPI_MS_DLEN`/`W0` FIFO assumptions, and the `DC`-ordering-over-one-socket
  premise are reasoned from the driver source, not confirmed against a
  running core.
- **Per-frame transaction count against real traffic** — the "Watch for"
  number. The meter and the batching path exist; the value needs a live flush
  to read.

**Carries forward:** the risk-register rows for the SPI controllers, the GPIO
stub, the bulk hook and the unwired socket are addressed in code but stay open
until the live boot confirms them. M7's `KEY_INT` wake line and M11's Probe-pin
tool now have the GPIO-output plumbing they were waiting on.

### Remaining sub-milestones

M6's TypeScript half is done and tested; the QEMU C half compiles but has never
run against a guest. These four slices close the gap, each with its own
demoable Done-when so progress is visible rather than "still integrating". They
are strictly ordered — each unblocks the next.

#### M6.1 · A firmware image boots again — `S` ✅ **done**

**Goal.** Get *any* image printing on UART0 under the current `.qemu` build,
because right now none does.

**Build**

- Reproduce and characterise the regression: the rebuilt
  `.qemu/build/qemu-system-xtensa` emits no ROM banner and no serial output
  for `.qemu/bench-flash.bin` (the M0 spike image), with or without a drive
  attached. A pristine (PinBench patch reverted) rebuild behaves identically,
  so this is bring-up drift in the checkout or the image, **not** M6's C.
- Check, in order: is the ESP32-S3 ROM blob present and loaded by this fork
  tag; does `spike/bin/mkflash.sh` regenerate a working `bench-flash.bin` from
  `spike/firmware/bench/.pio/build/esp32s3`; does a clean
  `rm -rf .qemu && npm run setup:emulator` produce a binary that boots; did a
  host toolchain / Homebrew bump change the build.
- Whatever the fix, encode it — a pinned ROM path, a `configure` flag, a
  regenerated image checked into the spike results, or a note in
  `setup-emulator.sh`. M2/M3 claimed this path worked; make it true again and
  keep it true.

**Done when.** `npm run dev`, File ▸ Open firmware image, the M0 spike image (or
a fresh Arduino build), Start — and the boot log scrolls in the serial dock,
exactly as M2's Done-when promised.

**Watch for.** The espressif fork prints ROM messages by default; total silence
usually means the image is not being mapped, not that the firmware hung. Bisect
with `-d in_asm,int` before assuming a firmware problem.

### Outcome

Not a regression in the checkout, the ROM blob, the image, or M6's C — the
`.qemu` binary boots `bench-flash.bin` fine. It was the **launch arguments**:
`EmulatorSupervisor` passed `-nographic -monitor none -serial stdio`.
`-nographic` already binds stdio to the default serial+monitor mux, so the
extra `-serial stdio` is rejected — `cannot use stdio by multiple character
devices` — and `-monitor none` swallows that error, leaving the UART connected
to nothing and the dock silent. It only ever "passed" because M2/M3's live
checks actually ran through the spike's `spike/run-bench.sh`, which uses
`-serial file:`, not the app's path.

- **Fix** (`src/main/emulator.ts`): drop `-monitor none` + `-serial stdio`,
  use the canonical headless form `-serial mon:stdio` (UART0 and monitor
  multiplexed on the one stdio chardev). Verified: the ROM banner, bootloader
  `load:`/`entry` lines and the firmware's own output now reach stdout with the
  exact arg list the app builds.
- No change needed to `setup-emulator.sh`, the ROM path, or `mkflash.sh` — none
  were implicated once the boot was tested with corrected args.
- Confirmed against a `-serial file:` control run (boots) and bisected the arg
  set: `-nographic … -serial mon:stdio -no-reboot` boots; `… -monitor none
  -serial stdio` is silent; `-nographic` alone with `-monitor none` is silent.

#### M6.2 · MeshCore for the M9, built and booted through PinBench — `M`

**Goal.** The real firmware this milestone is about, running.

**Build**

- Point PinBench's Open-project at a `meshcore-dev/MeshCore` checkout (PR #2942
  is merged into `dev`; the M9 support is `variants/thinknode_m9/` and
  `boards/thinknode_m9.json`). Pick env `ThinkNode_M9_companion_radio_usb` —
  no BLE, so nothing hits the WiFi/BLE non-goal, and no phone app is needed to
  see it run.
- Confirm the M3 build path handles it: 16 MB `default_16MB.csv` partitions,
  the PinBench-owned DIO `-c` override, the `adafruit/Adafruit GFX` lib
  dependency, and the merged-image size the launcher expects.
- Boot the result. Expect it to reach further than M0's "stalls before first
  serial output" now that GPIO output exists, but the SPI models are still
  untested — record exactly how far it gets and on what.

**Done when.** Build & flash a `companion_radio_usb` M9 image from a MeshCore
checkout and see MeshCore's own boot banner in the serial dock.

**Watch for.** `companion_radio_usb` brings up the USB CDC interface
(`-D ENABLE_USB_INTERFACE`); the console may land on the USB-serial device, not
UART0. Check which serial the banner comes out on before concluding it hung.

#### M6.3 · The bridge carries real traffic — `M`

**Goal.** Prove the GP-SPI2 register model and the GPIO observer against a
running core, not against reasoning from the driver source.

**Build**

- With MeshCore running and `PINBENCH_DEVICE_SOCKET` set, verify `Op.Gpio`
  frames arrive as `ST7789Spi::connect` pulses `RST` and toggles `DC`/`CS`,
  and `Op.Xfer` frames arrive as it clocks the init commands.
- Confirm the `SPI_MS_DLEN` / `SPI_W0..W15` FIFO assumptions in
  `pinbench_gpspi.c` match what Arduino-ESP32's `spiTransferBytesNL` actually
  writes for this SoC — fix the offsets or the bit math if a byte count or a
  command lands wrong. Confirm `SPI_CMD.UPDATE` self-clear does not spin the
  driver.
- Confirm the host routes the transaction to `u3` (LCD) because its `CS`
  (GPIO16) is low, and that asserting the radio's select instead routes there.
- Read the **transactions-per-frame** meter — the number M6's "Watch for" says
  to check before optimising anything.

**Done when.** The ST7789 model's OUT-panel *state* (not pixels yet) tracks
MeshCore's init: `poweredOn`, `displayOn`, `madctl`, the CASET/RASET window all
move to sensible values driven by the guest, and the Diagnostics dock is free of
`unimplemented command` / desync rows.

**Watch for.** Ordering: the `DC` GPIO write and the SPI transaction are
separate MMIO writes. If `onBus` sees the wrong `DC` level, the socket is
reordering or the GPIO observer is batching — it must forward each edge
synchronously.

#### M6.4 · Real firmware pixels — `M`

**Goal.** M6's original Done-when.

**Build**

- The ST7789 OUT panel shows what `ST7789Spi::display()` pushes — MeshCore's
  home screen, scaled from its 1bpp UI buffer to the 320×240 panel.
- Dirty-rect throttling so a partial-screen update does not repaint the whole
  canvas; the BL ON/OFF dimming and ½/¾/1:1 zoom from the design.
- Meters read real numbers: flush time per frame, dirty-rect count, bus share.
- Change the MeshCore home-screen draw code, rebuild, and the rendered screen
  changes.

**Done when.** Boot MeshCore, and the emulated panel draws the home screen —
node name, clock, battery. Edit the UI code, rebuild, and it changes. M6 closes.

**Watch for.** If the flush is visibly slow, count transactions per frame
(M6.3's meter) before touching the model's language — a chatty driver or a
per-byte controller path is the likely cause, exactly as M6's "Watch for" and
the risk register say.

## M7 · The keyboard: closing the interaction loop — `L`

**Goal.** Click a key in PinBench; watch the emulated firmware react on the
emulated screen. Input and output meet.

**Build**

- **ESP32-S2 keyboard coprocessor model** on I2C1 (`GPIO20/21`) with the
  `KEY_INT`/wake line on `GPIO12`: the matrix scan, the event queue the main core
  reads, and the wake assertion.
- **IN panel**: the 4-row QWERTY matrix from the design — `QWERTYUIOP` /
  `ASDFGHJKL⌫` / `⇧ZXCVBNM.⏎` / `SYM ␣ , / ⌥` — the 3×3 D-pad, the six dedicated
  keys (HOME, BACK, MENU, CHAT, MAP, LOC), and the text buffer readout.
- Real keyboard input focuses through to the emulated matrix when the panel has
  focus.
- **OUT panel**: key event log with row/column origin and scan code, plus event
  count, bus and wake-line meters.

**Done when.** You type on PinBench's on-screen keyboard and the characters
appear on the emulated LCD, having travelled through the coprocessor model, the
I2C bus, and MeshCore's real input handling.

**Watch for.** `GPIO12` is deliberately double-bound on the M9 (`KEY_INT` and
`ESP32_WAKEUP`). The pin-conflict checker in M10 must know this is intentional,
so record the exception in the board definition here rather than special-casing
it later.

## M8 · The radio: LR1110 — `XL`

**Goal.** Inject a mesh frame from the IN panel and watch MeshCore receive it.
This is the device the whole product exists for.

**Build**

- **LR1110 device model** on the shared SPI bus with `LR_NSS` (39), `LR_BUSY`
  (41), `DIO9`/IRQ (42) and `LR_NRESET` (45): the command set MeshCore actually
  uses — `SetPacketType`, `SetRfFrequency`, `SetModulationParams`, `SetTxParams`,
  TX/RX mode, buffer read/write, IRQ status and clear — with correct BUSY timing
  and DIO9 interrupt assertion.
- **Airtime model** derived from the active BW/SF/CR profile, so injected traffic
  and the airtime meter are consistent with LoRa reality rather than invented.
- **IN panel stimuli**, as designed: node advert from a given address at N hops,
  a channel message, a delivery ack, and a noise-floor burst with a configurable
  floor. Each carries the RSSI and SNR the OUT panel will report.
- **OUT panel**: TX/RX traffic log, and Frequency / Last RSSI / Airtime-used
  meters.
- **Inspector config** wired live: BW 125/250/500, SF 7/9/11, CR 5/6/8, TX power
  14/17/22.

**Done when.** With MeshCore running, inject `#public "trailhead in 20"` from the
IN panel and see it arrive in the serial log **and** appear on the emulated LCD's
channel list with an unread dot.

**Watch for.** The LR1110 command surface is large. Implement only what MeshCore
calls, driven by tracing real firmware traffic — and make unimplemented commands
raise a loud, named diagnostic rather than silently returning zeros. Silent
zeros will cost you days.

## M9 · Storage and navigation: microSD and GNSS — `L`

**Goal.** Two more real devices, and the first fault-injection story.

**Build**

- **SD-over-SPI model** on `SD_CS` (48): SPI-mode command set, a virtual card
  backed by a host image file, FAT32 via the firmware's own driver (PinBench
  serves blocks, it does not implement a filesystem). IN panel: insert card,
  load a map-tiles fixture, and **remove the card mid-write** — genuine fault
  injection that is genuinely awkward to do on real hardware.
- **ATGM336H GNSS model** on UART1 (`GPIO2/3`) with `GPS_EN` (11) and 1PPS on
  `GPIO4`: NMEA sentence generation from a replayable track. IN panel ships the
  three fixtures from the design — open sky (11 sats, 1.4 m), urban canyon
  (5 sats, 12 m), and tunnel (no fix) — with 1PPS asserted in step.
- OUT panels and meters for both.

**Done when.** MeshCore mounts the virtual card and logs to it; yanking the card
mid-write produces the firmware's real error path, not a PinBench crash. A
replayed track drives the fix and satellite count the firmware reports.

## M10 · Sensors and power — `M`

**Goal.** Finish the M9's device roster.

**Build**

- **PCF8563 RTC** on I2C0: time registers, alarm, and the 1PPS trim path from M9.
- **QMI8658B IMU** and **QMC6309 magnetometer** on the same isolated bus. IN panel
  stimuli: tilt the device to a given angle, rotate heading to a given bearing,
  set the RTC from the host.
- **Power model**: battery voltage on `BAT_ADC` (13) through the real divider
  ratio, charge state, `VDD_PERIPH` rail control on `GPIO18`, buzzer on `GPIO9`.
  IN panel: set battery percentage, plug and unplug USB-C, fire the buzzer —
  the low-battery and brownout paths become one click instead of a bench power
  supply.
- **I2C bus model** enforces the design's 400 kHz ceiling on the isolated sensor
  bus and warns above it.

**Done when.** Every part in the M9 board definition has a working model. The
canvas footer's `9 parts · 12 nets · 31 GPIO assigned` is computed, not written.

---

# Phase 5 — The canvas earns its place

## M11 · Canvas as editor, and pin-map codegen — `L`

**Goal.** `board_m9.h` says *"Edit the canvas, not this file: it is regenerated on
build."* Make that sentence true.

**Build**

- Canvas editing: drag parts, draw nets between pins with the Draw-net tool,
  reassign a peripheral to a different GPIO, add a part from the Library, delete
  one. Undo/redo throughout.
- **Codegen**: the board definition plus canvas state emits `board_m9.h` (the
  `#define` block) and the `build_flags` section of `platformio.ini`, with the
  generated-file header comment. Regenerated on build.
- **Verify pin map** — the design's `⌘B` — as a real rule engine:
  - a GPIO assigned to two signals (with declared exceptions like `GPIO12`),
  - strapping pins used unsafely (`GPIO0` and friends),
  - input-only pins driven as outputs,
  - **shared-bus chip-select rules**: assert that only one of `LR_NSS`, `LCD_CS`,
    `SD_CS` can be low at a time, and that the generated HAL enforces it,
  - peripherals mapped to pins their silicon cannot route.
- Findings land in the Diagnostics dock as `warn`/`info`/`note`/`ok` rows with
  clickable source references, matching the design.
- **Probe pin** tool: click a pin, see its live level, direction and recent
  transitions.

**Done when.** Move the LCD chip select from `GPIO16` to `GPIO21` on the canvas,
rebuild, and the firmware drives the new pin — while Verify flags the collision
with the keyboard's `SCL` before you get there.

**Watch for.** Round-tripping. If a user hand-edits `board_m9.h`, PinBench must
detect the divergence and ask, never silently overwrite. Getting this wrong
destroys trust in the tool permanently.

## M12 · Inspector configuration, live — `S`

**Goal.** The Inspector's segmented controls change real behaviour.

**Build**

- Config fields from the board definition drive either generated compile-time
  defines (CPU frequency, PSRAM, log level) or runtime device-model state (LoRa
  BW/SF/CR/power, LCD rotation and colour depth, I2C clock, IMU output rate).
- Fields that require a rebuild are marked as such and offer one.
- **Firmware hook** card and **Reveal in source**: each part declares the function
  it enters the firmware through (`Lr1110::begin()`, `HomePage::draw()`,
  `keyboard.attach()`), resolved to a real file and line by indexing the project.
- Config persists in the project file.

**Done when.** Changing SF from 11 to 7 in the Inspector changes the airtime the
radio meter reports and the modulation the firmware programs, with no manual
rebuild step in between.

---

# Phase 6 — Prove the abstraction

## M13 · Second board: Heltec Wireless Paper v1.1 — `L`

**Goal.** Adding a board is authoring data plus any missing device models. If it
is anything more than that, M4 and M5 were wrong and this is where you find out.

**Build**

- Heltec Wireless Paper v1.1 board definition.
- **E-ink display model** (250×122 landscape) — a genuinely different display
  class from the ST7789: partial vs full refresh, refresh latency, ghosting,
  and the long update times that make e-ink UI code distinctive.
- **SX1262 radio model** — a different LoRa part from the LR1110, which is
  precisely the test of whether M8's radio abstraction was really an abstraction.
- Whatever else the board needs that the M9 did not exercise.

**Done when.** Both boards are selectable from the board picker, each boots its
own MeshCore build, and no code outside the two board definitions and the new
device models changed.

**Watch for.** Your Heltec weather-station fork fetches over **WiFi**, which
QEMU does not emulate. That build will not run end-to-end under PinBench. Decide
here whether to stub the WiFi/HTTP layer at the API boundary — enough to let the
display and UI code run against canned weather data, which is most of what you
would want to iterate on anyway — or to declare it out of scope and say so
plainly in the docs.

## M14 · Generic expansion parts — `M`

**Goal.** PinBench stops being a two-board tool.

**Build**

- The design's expansion library: **LED**, **push button**, **NeoPixel strip**
  (RMT), **DHT22** (1-wire), **servo** (LEDC). Each a device model plus a Library
  entry plus codegen for its pin binding.
- Placing an expansion part on the canvas generates its defines and, where it
  makes sense, scaffold code.
- RMT and LEDC peripheral support in the emulator, which NeoPixel and servo need
  and which no milestone so far has required.

**Done when.** Drop a NeoPixel strip on the canvas, wire it to a free GPIO,
rebuild, and firmware driving it lights the rendered strip in its OUT panel.

---

# Phase 7 — Ship it

## M15 · Packaging, distribution and the contributor story — `L`

**Goal.** Other people can install PinBench and add device models to it.

**Build**

- macOS packaging: `.dmg`, code signing, notarisation, auto-update.
- Windows and Linux builds in CI, with the platform-specific work each needs
  (QEMU binary distribution, PlatformIO path discovery, device naming).
- Documentation site: getting started, the device-plugin authoring guide grown
  up from M4, the board-definition format reference, and the architecture
  overview with the M0 ADR at its centre.
- Example device model as a template repository.
- Release process: changelog, tagged releases, CI-built artifacts.

**Done when.** Someone who has never seen the codebase installs PinBench, boots
the M9, and lands a new device model as a PR — working only from the docs.

---

## Risk register

| Risk | Impact | Where it bites | Mitigation |
|------|--------|----------------|------------|
| ~~ESP32-S3 PSRAM emulation is incomplete and MeshCore needs 8 MB of it~~ | — | — | **Retired in M0.** 8 MB works, verified by allocation and read-back. Octal parts need `-global ssi_psram.is_octal=true`; passing no `-m` means silently no PSRAM. Both are M3 launcher flags. |
| ~~Bridge latency makes display flushes unusably slow~~ | — | — | **Retired in M0.** Batched: 0.62 ms/frame. The residual risk is not latency but *transaction count* — see the row below. |
| SPI2 and SPI3 host controllers do not exist in the fork | M6 and M8 cannot start without them | M6 | Found in M0. Scheduled explicitly as the first slice of M6, since M8 and M9 need the same controllers. Do not let it hide inside the ST7789 model's estimate. |
| The fork's GPIO peripheral is a stub — `esp32_gpio_write()` is empty, no output/enable state modelled | Any device on a plain GPIO stays dark; the ST7789's `DC`/`RST`/`BL` cannot be driven | M6 | Found in M4 (which deferred the "firmware toggles a GPIO → LED blinks" half for this reason). M6 must implement `GPIO_OUT`/`W1TS`/`W1TC` plus an observation hook — it is on the ST7789's critical path, and it also unblocks M7, M10 and M11. Scheduled as an explicit M6 Build bullet. |
| The M4 device-host socket transport is unit-tested but not wired into the app | The TS models cannot receive anything from a running guest | M6 | `DeviceHost.listen()` exists; nothing calls it because there is no QEMU client yet. M6's SPI controllers are the first client — an explicit M6 Build bullet picks the socket path and connects. |
| Firmware issues many small SPI transactions rather than few large ones | Display and radio become bridge-bound | M6, M8 | Each round trip costs tens of microseconds. Meter transactions per frame from the first ST7789 run; if a driver is chatty, batch in the controller before considering a native model. |
| M0's latency numbers were measured on Linux, not macOS | The per-transaction budget may be wrong on the target platform | Before M6 | Partly retired in M4: `scripts/bench-framing.mjs` clocks a standalone macOS Unix-socket round trip at ~5 µs, *faster* than Linux's ~50 µs, so the budget is a conservative ceiling here. Still owed: re-run `spike/run-bench.sh` through a live guest on macOS and add the in-guest table to ADR 0001. |
| LR1110 command surface is larger than expected | M8 balloons | M8 | Implement only what MeshCore calls; make unimplemented commands raise loud named diagnostics. |
| Espressif's QEMU fork diverges or stalls | Maintenance burden | Ongoing | Pin the fork and tag from M0. Keep PinBench's patches minimal and documented. Budget for periodic rebases. |
| No WiFi or BLE emulation | `companion_radio` and the weather-station fork cannot run fully | M13 | Named as a non-goal up front. Consider API-boundary stubs in M13 so display and UI code remains iterable. |
| PlatformIO toolchain bootstrap on user machines | Bad first-run experience | M3 | Detect early, guide explicitly, manage a virtualenv rather than fighting system Python. Your MeshCore notes are the source material. |
| The abstraction is wrong and M13 is a rewrite | Large rework | M13 | Sketch the Heltec board's needs against the M5 schema before committing to it, and treat M13's cost as the honest verdict on M4/M5. |

## Sequencing notes

- **M0 is done.** Full ESP32-S3 emulation of MeshCore is viable: the SoC boots,
  PSRAM works, and the firmware stalls only where peripherals are missing.
  Decision #2 stands. The cost that moved is M6, which now carries the SPI2/SPI3
  controllers.
- **M1 is done.** The shell, the Nocturne tokens, the panels, the menus and the
  canvas are in, driven by an M9 fixture that already implements the
  `BoardDefinition` types M5 will load from disk. CI runs typecheck, lint,
  format, tests and a build on macOS, Linux and Windows for every PR.
- **M2 is done.** The emulator supervisor (`src/main/emulator.ts`) spawns QEMU
  with `-machine esp32s3 -monitor none -serial stdio` and the correct PSRAM
  flags, streams UART0 into the serial dock (batched at 25ms, ANSI-stripped,
  ring-buffered to 10K lines), supports serial input, and guarantees child death
  on quit. File ▸ Open firmware image, Start, Stop, Reset are live. QEMU binary
  discovery checks `PINBENCH_QEMU` env → `.qemu/build/` → `~/.espressif/` →
  PATH; absence surfaces a crash diagnostic. `npm run setup:emulator` builds
  the espressif/qemu fork (tag `esp-develop-9.2.2-20260417`) with gcrypt into
  `.qemu/`, and `npm run dev` runs a fast preflight that verifies esp32s3
  machine support. Verified end-to-end: the M0 spike firmware boots, the boot
  log reaches the serial dock, and the firmware prints on UART0.
- **M3 is done.** PlatformIO integration closes the source-to-running-emulator
  loop: `pio` discovery, `platformio.ini` parsing and an env picker, a streamed
  `pio run` with phase transitions and cancellation, compiler-diagnostic
  parsing with click-through, an in-app `mkflash.sh` port, build caching, a
  real Source tab, and board-derived emulator launch options. The DIO override
  is a PinBench-owned `-c` config, never an edit to the user's file.
- **M4 is done.** The `DeviceModel` interface (transaction-shaped, no byte-level
  entry point), a switch-free registry, the QEMU-free test harness, the
  main-process device host with a defined throw/slow-call failure policy, the
  20-byte-header wire protocol with a measured framing overhead, and an LED
  model rendered in its OUT panel. The "firmware toggling a GPIO" half is
  deferred with M6: the espressif fork's GPIO peripheral is a stub
  (`esp32_gpio_write()` is empty), so real edges need the output registers in C
  plus an observation hook, alongside the SPI2/SPI3 controllers. A **Drive
  high / low** control drives the line in the meantime. ADR 0001 amended with
  the framing table and a first, favourable macOS socket number (~5 µs vs
  Linux's ~50 µs).
- **M5 is done.** The M9 is `boards/thinknode-m9-v1.0.board.json`, read and
  validated by `parseBoard` at launch; the M1/M4 fixtures (including the demo
  LED) are deleted and nothing board-specific survives in `src/`. Loading moved
  from the renderer into the main process (`board:load` replaces `device:load`).
  The fixture's invented pin map was reconciled against the numbers M7–M11
  state, so those milestones' demos work as written; the totals now read the
  design's `9 parts · 12 nets · 31 GPIO`. A tolerant `.pinbench` project file
  carries board id, PlatformIO dir + env and per-part config, with save,
  reopen-on-launch and recents. With the LED gone the M9 instantiates no device
  model until M6's ST7789.
- **M6 is in progress** — see its Progress section. The TypeScript half (the
  `sitronix.st7789` model, the framebuffer side channel, GPIO-based SPI
  routing, the bus-contention diagnostic, meters, the OUT-panel render, and
  `DeviceHost.listen()` wired to the emulator) is landed with 218 tests green.
  The QEMU C half (GP-SPI2/3 controllers, the bulk hook, GPIO output registers,
  the 20-byte socket bridge, and the `apply.sh` wired into `setup:emulator`)
  compiles and links into the fork but is not yet exercised by a live guest:
  the rebuilt `.qemu` binary does not boot even the M0 spike image in this
  environment, an emulator-bring-up problem upstream of M6's code. The four
  carry-overs it absorbed — the SPI2/SPI3 controllers (from M0), and from M4
  the bulk hook, the GPIO output registers, and the unwired socket — are
  written but stay open on the risk register until that live boot confirms
  them.
- **M9, M10 and M14 are parallelisable** once the device API is stable — they are
  independent devices against a fixed interface, which is exactly what the
  modular architecture was for.
- **M11 could move earlier** if canvas editing matters more to you than device
  breadth. It depends only on M5, not on the device milestones.
