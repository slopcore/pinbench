---
title: Device model plugin API
area: devices
status: done
---

# Device model plugin API

Every peripheral is a self-contained TypeScript module hosted in the PinBench
process — never C inside the QEMU fork. [ADR 0001](../adr/0001-device-model-boundary.md)
measured why: batching whole transactions is worth ~12,000×, rewriting a model
in C is worth ~6×. See [[decisions]]. Full guide: [Authoring a device
model](../devices/authoring.md).

## The interface

`src/shared/devices/model.ts` — `DeviceModel`:

- **Lifecycle**: `attach(ctx)` / `reset()` / `detach()`.
- **`onBus(txn) → BusResponse`** — takes and returns a _whole buffer_, every byte
  clocked between one chip-select assertion and its release. There is no
  byte-level entry point, by design — a per-byte interface would make an ST7789
  frame flush take 7.7 seconds. Budget by transaction count, not byte count.
- **`onSignal`** for digital lines (DC, RST, chip-selects, IRQ).
- **`onUartRx(bytes)`** / **`ctx.uartTx(bytes)`** — a UART is a free-running
  byte stream, not a transaction. QEMU's second `-serial` (UART1, as a unix
  socket chardev) is served by `DeviceHost.listenUart(1, path)` and routed to
  the part on the board's `uart` bus with `controller: 1`. Models reassemble
  their own framing.
- **`ctx.net`** — a `NetBackend` (`shared/devices/net.ts`) for parts that
  terminate TCP/IP themselves (the W5500). The main process lends real sockets
  (`src/main/net-backend.ts`) on a slirp-shaped guest net: 10.0.2.2 = host,
  10.0.2.3 = DNS relay, DHCP lease 10.0.2.15.
- **`onCommand`** for IN-panel stimuli.
- **`snapshot()`** — serialisable scalar state for the OUT panel.
- **`meters`** — declared OUT-panel meter rows.
- **`outputSignals`** — optional; lines the model drives back into the guest
  (e.g. `['BUSY','IRQ']`). Wired to a host→guest pin-level table (see
  [[qemu-fork]]).

## Registry — no central switch

A model file exports a `DeviceModelDescriptor`; `src/shared/devices/builtin.ts`
lists the files; a board references models by id. Adding a device is adding a
module and referencing it. An id with no registered model is a **visible no-op** —
the host reports it once and leaves the part inert.

## Test harness

`src/shared/devices/harness.ts` drives a model with scripted transactions and
signal edges, a virtual clock, and recorded events / diagnostics / driven lines —
**no QEMU, no Electron**. Every device model ships with harness tests.

## Failure policy

Models are synchronous by contract. A model that throws is **quarantined** — bus
replies become all-`0xFF` (never silent zeros) plus a named `error` diagnostic —
until `Reset`. A call over 50 ms raises a one-shot `warn`. A wrong-length reply
is padded/truncated with a diagnostic. The backstop for a genuinely hung guest is
the C-side socket read timeout.

## Wire protocol

`src/shared/devices/protocol.ts` — a 20-byte fixed header (magic, op, flags, bus
index, select, seq, ns timestamp, length) then payload, little-endian, with a
streaming `FrameDecoder`. Ops include `Xfer`, `Gpio`, `GpioRead`, `Reset`,
`Hello`. Framing overhead is ~4 µs for a full 153,600-byte frame, ~110 ns for a
1-byte transaction (`scripts/bench-framing.mjs`).

## Host

`DeviceHost` (`src/main/devices.ts`) runs a Unix-domain socket under `userData`,
started before any emulator spawn; `EmulatorSupervisor` passes the path as
`PINBENCH_DEVICE_SOCKET`. It maps GPIO pins to part+signal through the board
definition, routes each transfer to whichever device's chip-select is low
(`SPI_SELECT_SIGNALS` = `CS`/`NSS`/`SS`/`CSB`), and raises a **bus-contention
diagnostic** if two selects on one bus go low at once.
