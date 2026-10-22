---
title: Emulated network — slirp pass-through
area: emulation
status: working
status_note: 'End to end: the Heltec weather repeater resolves DNS and completes a TLS handshake to api.open-meteo.com under emulation. Verified by src/main/net-live.test.ts.'
---

# Emulated network — slirp pass-through

The ESP32-S3's WiFi MAC is not modelled by the QEMU fork ([[qemu-fork]]), so a
firmware that needs IP — the Heltec weather-station repeater fetching from
`api.open-meteo.com` — has nothing to talk to. Rather than model 802.11, PinBench
gives such a build a wired NIC with a route to the host.

## What PinBench does

- **Launch.** When the board's `emulator.network` is `"user"`, the emulator
  adds `-nic user,model=open_eth`. The fork already maps an **OpenCores
  Ethernet MAC** into the ESP32-S3 machine at `DR_REG_EMAC_BASE`
  (`0x600CD000`, descriptors at `+0x400`); this arg binds it to QEMU's
  **slirp** user-mode stack, which NATs the guest onto the host network
  (guest `10.0.2.15/24`, gateway `.2`, DNS `.3`). No host privileges, no TAP.
  `networkArgs()` in `src/shared/emulator.ts`; parsed in `src/shared/board.ts`.
- **Build.** The emulator build sets `PLATFORMIO_BUILD_FLAGS` with
  `-DPINBENCH_EMULATED_NET=1` plus GNU linker wrapping flags
  (`-Wl,--wrap=esp_wifi_*` for all major Wi-Fi API symbols via `wifiWrapBuildFlags()`),
  and adds PinBench's `runtime/` folder to `PLATFORMIO_LIB_EXTRA_DIRS`
  (`src/main/build.ts`). PlatformIO automatically compiles the built-in
  `runtime/pinbench-wifi-shim` library and links it into the emulator binary.
  This is _not_ done through the `-c` DIO override: `pio run -c` merges
  single-value options like `board_build.flash_mode`, but silently **drops**
  multi-value options — so `PLATFORMIO_BUILD_FLAGS` and `PLATFORMIO_LIB_EXTRA_DIRS`
  are used instead, leaving the user's `platformio.ini` untouched.

## How the transparent Wi-Fi shim works

The shim in `runtime/pinbench-wifi-shim/src/pinbench_wifi_shim.c` intercepts
Wi-Fi calls so standard Arduino sketches (`#include <WiFi.h>`) and ESP-IDF apps
run **100% unmodified**:

- **Wi-Fi API Wrapping:** Intercepts `esp_wifi_init()`, `esp_wifi_start()`,
  `esp_wifi_connect()`, `esp_wifi_set_mode()`, `esp_wifi_scan_start()`, etc.
  Instead of hitting unmodelled RF silicon registers in QEMU (which would hang
  the vCPU), the shim brings up the OpenCores MAC (`0x600CD000`) and lwIP netif.
- **Event Synthesis:** When `WiFi.begin()` or `esp_wifi_connect()` is called,
  the shim dispatches `WIFI_EVENT_STA_CONNECTED` and `IP_EVENT_STA_GOT_IP` to
  the event loop. Arduino's `WiFiClass` receives this and transitions to
  `WL_CONNECTED`, so standard loops like `while (WiFi.status() != WL_CONNECTED)`
  succeed immediately.
- **Synthetic Scanning:** `WiFi.scanNetworks()` returns a synthetic AP record
  (`PinBench-Emulated-WiFi`, -45 dBm) rather than hanging on an RF scan.
- **lwIP Routing:** Standard L4 clients (`HTTPClient`, `WiFiClient`, `WiFiClientSecure`,
  and POSIX sockets) route through lwIP's default netif over the OpenETH MAC,
  NAT'd to macOS's active network via QEMU SLIRP. Static slirp addressing
  (`10.0.2.15/24`, gw `10.0.2.2`, DNS `10.0.2.3`) is applied directly.
- **`tcpipInit()` & DNS:** The shim automatically ensures lwIP and Arduino's
  event system are initialized so DNS callbacks never hit a null dereference.

## Scope

A functional "the device is online" pass-through to the host network (macOS Wi-Fi/Ethernet).
Firmware uses standard `#include <WiFi.h>`, `WiFi.begin()`, `WiFi.status()`, `HTTPClient`,
and POSIX sockets with **zero code modifications**. Outbound NAT is active by default;
host-to-guest inbound requires `hostfwd` if desired.

## Status

Working end to end. `src/main/net-live.test.ts` (gated on `PINBENCH_NET_LIVE=1`

- `PINBENCH_HELTEC_IMAGE`) boots the merged image under `DeviceHost` + a
  slirp-backed `open_eth` NIC, captures the netdev to a pcap, and asserts: the
  repeater reaches its main loop, frames flow on the NIC, a DNS query goes out and
  a response comes back through the BD ring, and a TCP connection to
  `api.open-meteo.com:443` opens. A host-side `-d trace:open_eth_*` run shows the
  full exchange — ARP, DNS, TCP SYN/ACK, multi-segment TLS ServerHello + cert,
  HTTPS data. `heltec-live.test.ts` (the radio path) still passes 4/4 against the
  same build.
