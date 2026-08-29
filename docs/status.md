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
- Boards as validated data; two boards on disk; a runtime board picker — [[board-definitions]]
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
  Duplicate / Delete / Auto-arrange, edits persisted in `ProjectFile.boardEdits`
  and replayed on open; Build & flash writes the generated pin header into the
  checkout and File ▸ Import pin header reads one back as rebind edits —
  [[pin-map-verify-and-codegen]]
- Per-model Inspector IN panels from `shared/stimuli.ts` + a keyboard matrix;
  Library "Expansion · generic" and "Firmware modules" catalogue groups that
  drop a part onto the canvas

## Blocked

- **Live radio demo** — MeshCore's `radio_init()` `halt()`s at `-707` on a
  pre-existing fork GPIO fault (a bogus pin 227 from RadioLib's `Module` setup),
  _before_ it clocks any radio SPI. This gates: the LR1110 live channel-list
  demo, the M9 home screen (drawn only after `radio_init()`), the first
  end-to-end run through the Electron **Build & flash** button, and the keyboard
  milestone (no main loop until the radio is up). Fix is a fork-console / GPIO
  investigation. See [[qemu-fork]].
- **Heltec live boot** — builds clean, but the plain `esp32-s3-devkitc-1` variant
  hits a generic-SoC console/VFS init assert (`startup.c:320`) in the fork, not
  fixed by the DIO switch. The UC8151 and SX1262 models are proven by harness;
  the board loads and renders. Same class of fork work as the M9 blocker.

## Next

- **`folder-is-project`** — retire the `.pinbench` document. A session is a
  firmware **source folder** (opened directly, remembered in `session.json`) plus
  a **hardware profile** (its own `boards/*.board.json`, "Save hardware profile
  as…", last choice persisted). Per-(folder, profile) build env + Inspector
  config move into `session.json`. _Phase 1a landed:_ `SessionState` v2, the
  `app:launch-state` / `board:save-profile` / `board:remember` /
  `project:set-folder-state` IPC, and `collectEnvNames` (env detection that
  follows `extra_configs`, so MeshCore's variant envs show up). _Phase 2:_ the
  renderer Open-folder flow, an env picker, and removing the New / Save /
  Save-As-project menu items plus `boardEdits` replay-on-open —
  [[board-definitions]], [[firmware-build]]
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
