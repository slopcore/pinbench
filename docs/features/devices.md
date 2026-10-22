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

## galaxycore.gc9a01 — 1.28" round LCD (Waveshare ESP32-C6-Touch-LCD-1.28)

The ST7789 model with a `PanelVariant`: a 240×240 GRAM, Waveshare's vendor init
opcodes (from their `GC9A01.cpp` `lcd_panel_init`) swallowed silently, and
`nativeInversion` because the glass is normally-black (the driver always sends
`INVON`, so the frame reports true colour under it). The renderer masks it round.

## hynitron.cst816s — capacitive touch (Waveshare ESP32-C6-Touch-LCD-1.28)

The first I2C model (`Op.I2c`, I2C0 on the C6). A register file with an
auto-incrementing pointer — each address phase is its own transaction, so a
register read is a pointer write then a read, as on the silicon. Chip id `0xB5`
at `0xA7`; the 6-byte report at `0x01` (gesture, fingers, event<<6|X, Y) that
Waveshare's driver decodes. Each report is a 50 ms active-low INT pulse — wide
enough for the GPIO edge latch to see both edges, since Waveshare's `begin()`
binds a RISING ISR. Commands `touch` / `release` / `tap` / `gesture`; clicking
or dragging on the canvas's round panel drives it.

## wiznet.w5500 — Ethernet controller (Waveshare ESP32-S3-ETH)

Register-level: common block (VERSIONR `0x04`, PHYCFGR link bit, MR.RST,
IR/SIR/IMR/SIMR) and 8 socket blocks with TX/RX rings sized by
`Sn_*BUF_SIZE`. The SPI frame (`addr16, BSB|RWB|OM, data…`) is parsed as a
stream across CS-framed chunks. `Sn_TX_WR`/`Sn_RX_RD` latch on SEND/RECV — the
Arduino Ethernet library relies on it. TCP (connect, listen/accept, backpressure
via the RX ring) and UDP ride `ctx.net`; DHCP to port 67 is answered locally.
INT is active-low on unmasked IR/SIR. MACRAW (`esp_eth`'s mode) opens but is
**not bridged** — a diagnostic says so. Command `cable` {plugged}. Live proof:
`src/main/s3-eth-kit-live.test.ts` (stock Arduino Ethernet: DHCP, HTTP GET to
the host, TCP echo server reached from the host).

## elatec.twn4 — RFID/NFC reader (TWN4 MultiTech 3, T43O-F6C0)

The first UART model. `deviceOptions.protocol`: `simple` (default) — Elatec
Simple Protocol, ASCII mode (hex + CR each way, status byte first):
GetVersionString, SysTicks, USB/device type, SearchTag, SetRFOff,
Set/Get(Supported)TagTypes, Beep, GPIO/diag LED (`0400`–`040B`); anything else
answers `01` with an error diagnostic. `id` — prints the UID as hex + CR on
each presentation. Commands `present` {uid, type} / `remove`; the IN panel has
a UID/type form and presets. RF/crypto (MIFARE sectors, DESFire, iCLASS) is not
modelled.

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
