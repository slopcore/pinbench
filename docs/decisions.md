---
title: Locked architecture decisions
---

# Locked architecture decisions

Settled before implementation. Everything else follows from these.

| #   | Decision                    | Chosen                                 | Consequence                                                                                                                                                                                                          |
| --- | --------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Simulated or real hardware  | **Simulated first**                    | No board on the desk needed to develop or demo. ~~Real USB flashing is out of scope for v1.~~ Amended by [ADR 0003](adr/0003-usb-flashing.md): USB flash ships as an opt-in last step; simulation stays the default. |
| 2   | Simulation fidelity         | **Full ESP32-S3 emulation**            | The binary PinBench runs is the binary the board would run. Peripheral models are register-level, not behavioural mocks.                                                                                             |
| 3   | Where the binary comes from | **PinBench drives PlatformIO**         | The app detects/bootstraps `pio`, generates the pin-map header from the canvas, builds, and boots the result. Canvas edits change what executes. See [[firmware-build]].                                             |
| 4   | Board scope                 | **General workbench, modular devices** | Every board and device is a self-contained module loaded from data. See [[board-definitions]], [[device-model-api]].                                                                                                 |
| 5   | Device-model boundary       | **TypeScript over a batching bridge**  | Device models are TypeScript; native C is reserved for bus controllers and the bulk transfer hook. The axis that matters is per-byte vs batched, not C vs TS — [ADR 0001](adr/0001-device-model-boundary.md).        |
| 6   | Desktop stack               | **Electron + TypeScript**              | PinBench supervises long-running child processes (QEMU, PlatformIO) and hosts device models in-process — Node's home turf.                                                                                           |
| 7   | Platforms                   | **macOS first, portable code**         | Develop and package for macOS; keep every path, binary lookup and device-naming assumption platform-agnostic. Windows/Linux are a discrete later milestone.                                                          |
| 8   | Posture                     | **Serious OSS project**                | Device models get a test harness and a documented plugin API from the moment the API exists. CI from the first shell commit. Contributor docs are a deliverable.                                                     |

The full measurements behind #5 are in [ADR 0001](adr/0001-device-model-boundary.md):
a TypeScript display model does a full 153,600-byte frame in 0.62 ms when handed
whole buffers, vs 7,712 ms one byte at a time. Batching is worth ~12,000×;
rewriting in C is worth ~6×.

The agent control plane's design is [ADR 0002](adr/0002-acp-control-plane.md) —
see [[agent-control-plane]]. USB flashing amends decision #1 —
[ADR 0003](adr/0003-usb-flashing.md), [[usb-flashing]].
