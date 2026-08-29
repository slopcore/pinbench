---
title: Status — done, blocked, next
---

# Status — done, blocked, next

## Working

- Boot a firmware binary under QEMU; read and write its serial console — [[emulation-and-serial]]
- Build firmware from a PlatformIO checkout and boot the result, with a DIO
  override that never edits the user's file — [[firmware-build]]
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
- Verify pin map (rule engine) + pin-map C-header codegen with a
  divergence guard — [[pin-map-verify-and-codegen]]
- Agent control plane: pure core, loopback MCP control server, agent-side
  connection, deferred operations — [[agent-control-plane]]
- QEMU fork patches: GP-SPI2/3, GPIO in/out, the device-host socket bridge — [[qemu-fork]]
- Design-parity pass (see `TODO.md`, tiers 1–8): rich canvas node cards
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

## Blocked

- **Live radio demo (M9 / LR1110)** — MeshCore's `radio_init()` `halt()`s at
  `-707` on the M9 board on a pre-existing fork GPIO fault (a bogus pin 227 from
  RadioLib's `Module` setup), _before_ it clocks any radio SPI. Still open. Of
  the three Heltec fixes only the GPIO enable-edge forward (`esp32_gpio.c`) is
  board-agnostic; bus-routing is gated on >1 SPI bus (M9 has one) and the SX126x
  reassembly is a different model. But `ArduinoHal::spiTransfer` is shared across
  every RadioLib module — it clocks one byte per SPI USR pulse — so if `-707`
  outlives the GPIO fix, `lr1110.ts` likely needs the same NSS-framed
  reassembly the SX1262 model just got. See [[qemu-fork]].

## Recently unblocked

- **Heltec live boot — the e-paper screen now renders.** MeshCore's
  `Heltec_Wireless_Paper_repeater` boots through display detection, `radio_init()`
  and into its main loop; the OutPanel shows the firmware's "Please wait…" screen
  (partial refresh, custom LUTs). Three bugs, all fixed on branch `usb-flash`:
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
- Agent session dock panel + the `pinbench-mcp` stdio bridge — [[agent-control-plane]]
- microSD + GNSS models with fault injection; RTC / IMU / magnetometer / power
  models — the Inspector IN panels now send the stimulus commands; the QEMU-side
  models need to consume them
- Generic expansion parts (LED, button, NeoPixel, DHT22, servo) are in the
  Library catalogue and place on the canvas; live models need RMT/LEDC in the
  fork
- Packaging: `.dmg` + signing + notarisation, Windows/Linux CI, a docs site, a
  template device-model repo
