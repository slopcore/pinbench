---
title: PinBench documentation
---

# PinBench

A cross-platform desktop workbench for embedded mesh-radio boards. PinBench
configures and simulates the **hardware**: it emulates the board, runs your
**real firmware binary** under emulation, and gives every peripheral a panel to
configure, stimulate and observe. It also has a wiring canvas that defines the
board's pin map, and a serial console. The code itself lives in your IDE.
PinBench builds the firmware folder but never edits it. Instead it reports what
the firmware needs to change ([[firmware-actions]]).

Boards: **ThinkNode M9 V1.0** (ESP32-S3-R8, MeshCore) and **Heltec Wireless
Paper v1.1**.

## What works today

| Area                                                                                                                  | Note                           |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Boot a firmware binary under QEMU, read/write its serial console                                                      | [[emulation-and-serial]]       |
| Build firmware from a PlatformIO checkout, boot the result                                                            | [[firmware-build]]             |
| Write a device model in TypeScript against a stable plugin API                                                        | [[device-model-api]]           |
| Device models: ST7789 LCD, LR1110 radio, UC8151 e-ink, SX1262 radio, LED                                              | [[devices]]                    |
| Real firmware pixels on the emulated LCD, live edit→rebuild→pixels loop                                               | [[display-pipeline]]           |
| Inject mesh frames, model LoRa airtime, drive the radio from IN/OUT panels                                            | [[radio]]                      |
| Boards are data — a validated JSON schema, two boards on disk, a picker                                               | [[board-definitions]]          |
| Verify the pin map (rule engine) and generate the pin-map C header                                                    | [[pin-map-verify-and-codegen]] |
| Tell the IDE what the firmware must change: dock tab, `firmware_actions` MCP tool, `.pinbench/actions.md`             | [[firmware-actions]]           |
| Drive PinBench from a coding agent over ACP + MCP — with a dock Agent panel and a stdio bridge for Stdio-only clients | [[agent-control-plane]]        |
| Flash real hardware over USB — board-native build + esptool, flash / erase + flash (built, not yet run on a board)    | [[usb-flashing]]               |
| The QEMU fork patches: GP-SPI2/3, GPIO in/out, the device-host socket bridge                                          | [[qemu-fork]]                  |
| Emulated IP: QEMU slirp + OpenCores Ethernet MAC as a WiFi stand-in for opt-in builds                                 | [[emulated-network]]           |

## Reference

- [[decisions]] — the eight locked architecture decisions
- [[non-goals]] — what PinBench v1 deliberately does not do
- [[status]] — what is done, what is blocked, what is next
- [ADR 0001](adr/0001-device-model-boundary.md) — device models are TypeScript
- [ADR 0002](adr/0002-acp-control-plane.md) — the agent control plane
- [ADR 0003](adr/0003-usb-flashing.md) — flashing real hardware over USB
- [Authoring a device model](devices/authoring.md)
