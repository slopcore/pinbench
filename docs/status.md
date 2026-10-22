---
title: Status — done, blocked, next
---

# Status — done, blocked, next

## Working

- Boot a firmware binary under QEMU; read and write its serial console — [[emulation-and-serial]]
- Build firmware from a PlatformIO checkout and boot the result, with a DIO
  override that never edits the user's file — [[firmware-build]]
- Hardware-only focus: code lives in the IDE. The Source tab, the file tree and
  pin-header writes are gone. What the firmware owes the hardware profile is
  reported as firmware actions in a dock tab, the `firmware_actions` MCP tool and
  the self-ignoring `.pinbench/actions.md`. File:line links open the external
  editor — [[firmware-actions]]
- The device-model plugin API: transaction-shaped interface, switch-free
  registry, QEMU-free test harness, 20-byte wire protocol, defined failure
  policy — [[device-model-api]]
- Device models: ST7789 LCD, LR1110 radio, UC8151 e-ink, SX1262 radio, LED — [[devices]]
- Real firmware pixels on the emulated M9 LCD; live edit→rebuild→pixels loop;
  dirty-rect partial repaint; SPI bus-contention diagnostic — [[display-pipeline]]
- LR1110 frame injection, LoRa airtime model, IN/OUT panels, live host→guest
  BUSY/DIO9 line reads — [[radio]]
- Boards as validated data; two boards on disk; a runtime hardware-profile
  picker (choice persisted); **File ▸ Save hardware profile as…** writes canvas
  edits to a new `boards/*.board.json` — [[board-definitions]]
- No `.pinbench` document: a session is a firmware **source folder** (File ▸
  Open…, reopened on launch) + a **hardware profile**, with per-(folder,
  profile) build env + Inspector config in `session.json`. Env detection follows
  `extra_configs`, so a repo with per-variant `platformio.ini` files populates
  the picker — [[board-definitions]], [[firmware-build]]
- **Session bar** under the menu bar: `Firmware` (recents dropdown +
  Browse…, via the dialog-free `project:open-at` IPC), `Hardware` (profile),
  `Env` (build environment). The env list defaults to the profile-compatible
  subset (`matchFirmwareEnvs` off the board's `firmware.envMatch`) with an
  "All envs" toggle. Switching the profile keeps the open folder — `Root`
  re-resolves launch state before the `<App>` remount. The status bar shows
  profile + env as read-only text — [[board-definitions]]
- Verify pin map (rule engine) + pin-map C-header codegen with a
  divergence guard — [[pin-map-verify-and-codegen]]
- Agent control plane: pure core, loopback MCP control server, agent-side
  connection, deferred operations — and now the **dock Agent panel** (running
  turn, prompt box, Stop, auto-approve toggle, inline permission prompts that
  fall back to the native dialog when the panel is closed), a shared
  `session/update` reducer that merges tool calls by id, and the `pinbench-mcp`
  stdio↔HTTP bridge for
  `Stdio`-only MCP clients. `terminal/*` is deliberately excluded (ADR 0002).
  Live run vs. a real agent binary still owed — [[agent-control-plane]]
- QEMU fork patches: GP-SPI2/3, GPIO in/out, the device-host socket bridge — [[qemu-fork]]
- Design-parity pass: rich canvas node cards
  (CFG/IN/OUT), net labels + bus-labels toggle + bus-filter chips, canvas stats
  chip and shared-SPI toast, Inspector Identity/Nets/firmware-hook sections,
  Verify button + port label, Export/Import pin header, Help sheet, Dock meta
  line + collapse chevron, on-panel screen-zoom picker + `BL` toggle (a second
  surface onto the Inspector's `scale` / `backlight` fields) — section A of the
  gap report is now fully built and unit-tested
- Canvas editing: drag parts, Draw-net / Probe tools, ⌘Z undo/redo,
  Duplicate / Delete / Auto-arrange. Edits are live session state; **File ▸ Save
  hardware profile as…** bakes them into a new `boards/<id>.board.json`
  ([[board-definitions]]). Build & flash writes the generated pin header into the
  checkout and File ▸ Import pin header reads one back as rebind edits —
  [[pin-map-verify-and-codegen]]
- Per-model Inspector IN panels from `shared/stimuli.ts` + a keyboard matrix;
  Library "Expansion · generic" and "Firmware modules" catalogue groups that
  drop a part onto the canvas
- **Incoming radio message, end to end on Heltec / SX1262.** The radio IN panel
  now covers `semtech.sx1262` (it shared the LR1110's null renderer before);
  injecting a `channel` frame builds a MeshCore-shaped wire packet, raises
  RxDone and drives DIO1. The fork's `esp32_gpio.c` gained a GPIO edge-interrupt
  path (poll-detected, since the bridge has no async push), so the guest's
  `attachInterrupt()` on DIO1 fires and MeshCore's dispatcher reads the frame
  off the radio. `src/main/heltec-live.test.ts` proves it against a live
  repeater (`PINBENCH_LIVE_QEMU=1` + `PINBENCH_HELTEC_IMAGE`) — [[qemu-fork]],
  [[radio]]
- **Live radio demo on M9 / LR1110 — the `-707` is fixed.** MeshCore's
  `ThinkNode_M9_repeater_` now boots past `radio_init()` to `Repeater ID:` and
  takes an injected `channel` frame that drives DIO9 and is serviced by the
  guest ISR. Two fixes: (1) `variants/thinknode_m9/target.cpp` never called
  `SPI.begin()` (the sibling `thinknode_m7` does) — its `Module` used the global
  `SPI` with no bus init, so every RadioLib transfer was a silent no-op and
  `getVersion` read zeros; now a dedicated `SPIClass spi` is `begin()`-ed with
  the LoRa pins. (2) `lr1110.ts` assumed a whole command per `onBus`, but
  `ArduinoHal` clocks one byte per SPI transaction — it now reassembles the
  NSS-framed byte stream exactly as `sx1262.ts` does (`renderFrame` /
  `commitFrame`, opcode = `frameMosi[0..1]`, LR11x0's two-transaction read).
  The old "pin 227 / `__pinMode` invalid" line is a benign display-init artifact
  four seconds before radio bring-up — unrelated. **The M9 boot is not slow —
  traced at ~6.5 s warm, ~10.5 s on a fresh flash** (the extra ~3.6 s is a
  one-time `SPIFFS.begin(true)` format of the empty partition). The roadmap's
  "~2.5 min" was never a measurement, just `m9-live.test.ts`'s wait constant
  (now 30 s). The "slow I2C NAK" theory is disproven: the fork's ESP32-S3
  machine models no I2C peripheral (regs read 0 via the `esp32s3.iomem`
  catch-all), so MeshCore's 112-address scan just eats ~112 × 50 ms of `Wire`
  timeout and is invisible against radio/FS init. Phase breakdown:
  `src/main/m9-trace.test.ts` — [[qemu-fork]]. `src/main/m9-live.test.ts` proves the radio path against a live repeater
  (`PINBENCH_LIVE_QEMU=1` + `PINBENCH_M9_IMAGE`, `PINBENCH_M9_BOOT_MS` tunes the
  wait) — [[qemu-fork]], [[radio]]

## Blocked

- **Emulated network (slirp pass-through) — working end to end.** A board with
  `emulator.network: "user"` launches with a slirp-backed `open_eth` NIC (the
  fork already maps an OpenCores Ethernet MAC into the S3 machine; QEMU here is
  built with slirp), and the emulator build injects `-D PINBENCH_EMULATED_NET=1`
  via `PLATFORMIO_BUILD_FLAGS` (NOT the `-c` override — `pio run -c` drops a
  multi-value `build_flags` line from a section it did not originate; that bug
  is why an earlier pass looked done but shipped a non-networked firmware).
  Firmware side, in the MeshCore checkout
  (`variants/heltec_wireless_paper/pinbench_net.c`): a poll-mode OpenCores MAC
  register/BD-ring driver attached to lwIP **raw** (`netif_add` on the tcpip
  thread) with slirp's **static** addressing — no `esp_netif` ETH netstack (its
  `ethernetif_init` needs a real `esp_eth` handle) and no DHCP (Espressif's
  `dhcp_start` port calls back into `esp_netif`). `setup()` calls the framework
  internal `tcpipInit()` first so arduino-esp32's DNS callback has its event
  group. `src/main/net-live.test.ts` (`PINBENCH_NET_LIVE=1`) boots the image
  under `DeviceHost` + the NIC and asserts DNS resolves and a TLS connection to
  `api.open-meteo.com:443` opens; `-d trace:open_eth_*` shows the full ARP → DNS
  → TCP → multi-segment TLS exchange. `heltec-live.test.ts` (radio) still 4/4.
  See [[emulated-network]].

- **Heltec repeater boots to a running main loop and takes an injected radio
  packet.**
  Two things gate a full boot:
  1. The emulator flash-mode override PinBench's Build & flash already applies
     (DIO flash mode + a `dio_qspi` memory type) is **mandatory** — a raw
     `pio run` builds QIO and asserts in `do_core_init` under `m25p80` (see
     `src/shared/pio.ts`). Only bites hand builds.
  2. `setup()` must not call a **blocking** WiFi API — QEMU models no WiFi, so
     e.g. `WiFi.scanNetworks()` hangs the guest right after "Repeater ID".
     Firmware that scans or connects synchronously in `setup()` never reaches
     its main loop under emulation. Make the call non-blocking, or skip it
     under `PINBENCH_EMULATED_NET` ([[emulated-network]]).
- **Heltec live boot works from a cold open.** Launch PinBench with the
  Heltec Wireless Paper profile, File ▸ Open the MeshCore checkout, hit ▶ —
  the build picks `Heltec_Wireless_Paper_repeater`, QEMU boots into the
  repeater's main loop, and the U3 e-paper OUT panel shows the firmware's
  "Please wait…" screen. The env auto-selects from a new optional
  `firmware` hint in `boards/*.board.json` (`{ env, envMatch }`,
  resolved by `pickFirmwareEnv`) — without it, `envs[0]` across MeshCore's
  ~500 variant envs is `Ebyte_EoRa-S3_Repeater`, the wrong firmware for
  the board. Verified end to end via a Playwright `_electron` drive.
- **The three Heltec boot bugs**, all fixed earlier on branch `usb-flash`:
  1. **e-ink init hang** (was misattributed to `startup.c:320`) — the fork only
     forwarded GPIO `OUT` _changes_, so `E213Display::detectEInk()`'s first-touch
     `digitalWrite(RST, LOW)` over a reset-0 pin produced no frame and the panel
     controller was mis-detected. Fix: forward a pin's `OUT` level on the
     `ENABLE` 0→1 edge (`qemu/hw/gpio/esp32_gpio.c`).
  2. **SPI bus mis-routing** — the fork maps GP-SPI2 and GP-SPI3 both to
     `bus_index 0`; `deviceForXfer` mapped index 0 to the first board bus only
     (`spi-radio`), so every SPI transaction — e-ink included — went to the
     SX1262 model and the e-ink got nothing. Fix: when a board has >1 SPI bus,
     route by chip-select across all SPI devices (`src/main/devices.ts`).
  3. **`radio init failed: -2`** — RadioLib's `ArduinoHal` clocks each SX126x
     command one byte per SPI transaction; the `sx1262` model assumed whole
     frames, so `findChip()`'s version read never spelled `SX1261`. Fix: the
     model now reassembles a frame across NSS-framed 1-byte `onBus` calls and
     applies write side-effects on the NSS rising edge (`src/shared/devices/sx1262.ts`).

## Next

- Flash real hardware over USB — board-native rebuild + `esptool` _Flash_ /
  _Erase + flash_, `pio device list` port picker. Shared layer, `UsbFlashRunner`
  and the dialog are built and unit-tested; **not yet run against a physical
  board** — [[usb-flashing]], [ADR 0003](adr/0003-usb-flashing.md)
- microSD + GNSS models with fault injection; RTC / IMU / magnetometer / power
  models — the Inspector IN panels now send the stimulus commands; the QEMU-side
  models need to consume them
- Generic expansion parts (LED, button, NeoPixel, DHT22, servo) are in the
  Library catalogue and place on the canvas; live models need RMT/LEDC in the
  fork
- Packaging: `.dmg` + signing + notarisation, Windows/Linux CI, a docs site, a
  template device-model repo
