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

## M2 · Boot a binary and see its serial output — `L`

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

## M3 · Build the firmware from inside PinBench — `L`

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

---

# Phase 3 — The device architecture

## M4 · Device plugin API and first device — `L`

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

## M5 · Board definitions, and the M9 as data — `M`

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

---

# Phase 4 — The payoff

## M6 · The display: ST7789, and real firmware pixels — `XL`

**Goal.** The moment PinBench justifies choosing full emulation. The LCD's OUT
panel shows the MeshCore home screen — not a lookalike drawn in TypeScript, but
the output of `ui_home.cpp`'s `draw()` running on an emulated Xtensa core.

**Build**

- **SPI2/SPI3 host controllers, in C, in the fork.** The espressif fork models
  SPI1 only — the flash and PSRAM controller. Every peripheral on the M9 sits on
  SPI2 or SPI3, so those controllers do not exist yet and nothing on this board
  can talk until they do. Register-level models with the bulk hook from M4. This
  is the largest piece of work in the milestone and it is infrastructure the
  radio (M8) and microSD (M9) need too, so treat it as its own slice inside M6
  and land it first.
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
| Firmware issues many small SPI transactions rather than few large ones | Display and radio become bridge-bound | M6, M8 | Each round trip costs tens of microseconds. Meter transactions per frame from the first ST7789 run; if a driver is chatty, batch in the controller before considering a native model. |
| M0's latency numbers were measured on Linux, not macOS | The per-transaction budget may be wrong on the target platform | Before M6 | Re-run `spike/run-bench.sh` on macOS and amend ADR 0001. The batching conclusion is platform-independent; the budget is not. |
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
- **M2 is the next milestone.** It needs nothing from M1 beyond the dock and the
  supervised-process seam the main process already has.
- **M6 is the demo milestone.** Everything before it is plumbing; it is the first
  slice that makes the project's premise obvious to someone watching. If you need
  to show PinBench to anyone, show them M6.
- **M9, M10 and M14 are parallelisable** once the device API is stable — they are
  independent devices against a fixed interface, which is exactly what the
  modular architecture was for.
- **M11 could move earlier** if canvas editing matters more to you than device
  breadth. It depends only on M5, not on the device milestones.
