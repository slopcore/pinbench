---
title: Non-goals for v1
---

# Non-goals for v1

- ~~**Flashing real hardware over USB.**~~ Shipped in M17 as an opt-in last
  step — **Flash over USB** (⌘⇧U), _Flash_ / _Erase + flash_. See
  [ADR 0003](adr/0003-usb-flashing.md) and [[usb-flashing]]. "Build & flash"
  still means build and boot in the **emulator**; simulation is the default.
- **Emulating the ESP32-S3's own WiFi and BLE.** Espressif's QEMU fork does not
  implement the wireless peripherals. The M9's _mesh_ radio is an external
  LR1110 on SPI and is fully emulable, but MeshCore's `companion_radio` BLE
  transport is not, and the Heltec weather-station fork's WiFi fetch is not. The
  shipped Heltec build (`Heltec_Wireless_Paper_repeater`) is LoRa-only and needs
  neither — the WiFi fetch stays out of scope, no stub, no shim.
- **Schematic capture or PCB export.** The canvas is a pin-map and net editor,
  not an EDA tool. No netlist export, no footprints, no ERC beyond
  pin-assignment rules.
- **Cycle-accurate timing.** Peripheral models aim for functional correctness and
  plausible ordering. Code that depends on exact instruction timing will not
  behave identically.
- **A public device-plugin marketplace.** The plugin API is documented and
  stable-ish; distribution of third-party devices is out of scope.
