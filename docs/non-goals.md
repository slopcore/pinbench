---
title: Non-goals for v1
---

# Non-goals for v1

- ~~**Flashing real hardware over USB.**~~ Shipped in M17 as an opt-in last
  step — **Flash over USB** (⌘⇧U), _Flash_ / _Erase + flash_. See
  [ADR 0003](adr/0003-usb-flashing.md) and [[usb-flashing]]. "Build & flash"
  still means build and boot in the **emulator**; simulation is the default.
- **Emulating the ESP32-S3's own WiFi and BLE radios.** Espressif's QEMU fork
  does not implement the wireless MACs, and PinBench does not add them. The M9's
  _mesh_ radio is an external LR1110 on SPI and is fully emulable; MeshCore's
  `companion_radio` BLE transport is not, and never will be here.

  **IP connectivity, though, is now in scope** for a build that opts in. A
  board whose `emulator.network` is `"user"` launches with the fork's
  OpenCores Ethernet MAC on QEMU's slirp user stack — NAT'd pass-through to the
  host's real network — and PinBench's emulator build defines
  `PINBENCH_EMULATED_NET` so the firmware brings that NIC up (static slirp
  addressing, DNS, default route) in place of WiFi. The Heltec weather-station
  repeater resolves and reaches `api.open-meteo.com` over TLS this way. This is
  a functional stand-in for "the device is online",
  not WiFi emulation: no SSID scan, no association, no RSSI, and 802.11-specific
  code paths still do nothing. See [[emulated-network]].

- **Editing or writing firmware source.** Code lives in the external IDE.
  PinBench reads and builds the opened PlatformIO folder but never edits it.
  There is no source view, and neither PinBench nor its agent tools write code.
  What the firmware owes the simulated hardware is reported as
  [[firmware-actions]] for the IDE (or its coding agent) to act on. The one file
  PinBench writes there is the self-ignoring `.pinbench/actions.md`.
- **Schematic capture or PCB export.** The canvas is a pin-map and net editor,
  not an EDA tool. No netlist export, no footprints, no ERC beyond
  pin-assignment rules.
- **Cycle-accurate timing.** Peripheral models aim for functional correctness and
  plausible ordering. Code that depends on exact instruction timing will not
  behave identically.
- **A public device-plugin marketplace.** The plugin API is documented and
  stable-ish; distribution of third-party devices is out of scope.
