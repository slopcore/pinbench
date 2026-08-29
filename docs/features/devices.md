---
title: Implemented device models
area: devices
status: done
---

# Implemented device models

All are pure `src/shared/devices/*`, registered in `builtin.ts`, harness-tested
without QEMU. Written against the [[device-model-api]].

## sitronix.st7789 — 2.4" LCD (M9)

Transaction-shaped command state machine: SWRESET/SLPOUT/DISPON/INVON, `COLMOD`
16/18bpp, `MADCTL` orientation, `CASET`/`RASET` window addressing,
`RAMWR`/`RAMWRC` streaming with cursor wrap and MX/MY/MV scan order. 240×320
RGB565 GRAM; `RST`/`BL` lines with configurable polarity (via
`PartDefinition.deviceOptions`, e.g. `backlightActiveHigh: false`). Unimplemented
commands raise a loud named diagnostic. Meters: flush time/frame, dirty-rect
count, transactions/frame, bus share. See [[display-pipeline]].

## semtech.lr1110 — LoRa radio (M9)

Framing is RadioLib's `Module::SPItransferStream`: 16-bit big-endian opcode, one
`NSS` group per transaction. Reads are two transactions (opcode write, then a
NOP whose reply is `[Stat1, ...data]`); the model tracks a `pendingRead`.
`SPIparseStatus` gate: `Stat1` bits 3:1 = `CMD_OK`, `GetVersion` device byte =
`0x01`. Modelled: `SetStandby`/`SetFs`/`SetSleep`, `SetPacketType`,
`SetRfFrequency`, `SetModulationParams`, `SetTxParams`, `WriteBuffer`,
`SetDioIrqParams`+`ClearIrq`, `SetTx` → `IRQ_TX_DONE` + DIO9 pulse + airtime.
`NRESET` low→high is a hardware reset. ~40 further opcodes accepted silently;
anything else is one `warn`. `outputSignals: ['BUSY','IRQ']`. See [[radio]].

## ultrachip.uc8151 — e-ink display (Heltec Wireless Paper v1.1)

A 128×250 1-bit e-paper model — a genuinely different display class from the
ST7789. RAM is buffered in two planes (`DTM1`/`DTM2`, 0x10/0x13) and only latches
to the visible frame on `DRF` (0x12), with a modelled refresh time (full ~2 s /
partial ~480 ms) as a meter. `BUSY` is **active-low** on this controller, driven
as an `outputSignal` pulsed around `PON`/`DRF` so `display.begin()`'s wait
clears. LUT registers 0x20–0x24. Renders via `EInkScreen` from a `mono1`
framebuffer.

> The Heltec V1.1 panel controller is UC8151, not SSD1680 — `heltec-eink-modules`
> resolves `EInkDisplay_WirelessPaperV1_1` to its `LCMEN2R13EFC1` driver. The
> earlier Wireless Paper V1 panel is the SSD1680.

## semtech.sx1262 — LoRa radio (Heltec Wireless Paper v1.1)

8-bit opcodes (not the LR11x0's 16-bit), an in-band status byte at `statusPos =
1` in every SPI response. `GetStatus` / `SetStandby` / `SetPacketType` /
`SetRfFrequency` / `SetModulationParams` / `SetPacketParams` / `SetTxParams` /
`WriteBuffer` / `ReadBuffer` / `SetTx` / `SetRx` / `GetIrqStatus` /
`ClearIrqStatus` / `SetDioIrqParams`, `WriteRegister`/`ReadRegister` (0x0D/0x1D).
Version register answers `SX1261` (RadioLib's `SX1262` class shares that
`chipType`). `BUSY` (held high while processing) and `DIO1` (IRQ) are
`outputSignals`; `DIO2_AS_RF_SWITCH` / `DIO3_TCXO` writes are accepted no-ops.
**Airtime reuses `loraToaMs` from `lr1110.ts` unchanged** — a test pins it equal
to the LR1110's for identical LoRa params. This is the abstraction check: a
different LoRa part slotted in as pure data + a model.

## pinbench.led — LED on a GPIO

Active-high/-low LED with edge, duty-cycle and event outputs. Rendered as a bulb
in the OUT panel. The worked example the authoring guide points at. (Not
instantiated by either shipped board; retained as the API's smallest example.)
