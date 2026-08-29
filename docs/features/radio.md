---
title: Radio — injection, airtime, panels
area: radio
status: done
status_note: "TypeScript half complete; live end-to-end demo blocked — see [[status]]"
---

# Radio — injection, airtime, panels

The LR1110 ([[devices]]) is driven from the Inspector's IN and OUT panels. The
model, panels, airtime maths and injection surface are all in and harness-tested;
the live end-to-end demo (inject a frame, see it on the emulated LCD's channel
list) is blocked on a pre-existing QEMU fork GPIO fault — see [[status]].

## Frame injection

`onCommand('inject', { kind })` from the IN panel:

- `advert` — node advert from a given address at N hops
- `channel` — a channel message (`#public "…"`, `text` arg)
- `ack` — a delivery ack
- `noise` — a noise-floor burst (moves `noiseFloorDbm` only, no IRQ)

An injected packet builds a plausible-shaped mesh frame `[type, src(4), hops,
body]`, fills the RX buffer, raises `IRQ_RX_DONE`, and pulses DIO9 via
`driveSignal('IRQ', 1)`. The firmware then reads it back through
`GET_RX_BUFFER_STATUS` / `READ_BUFFER` / `GET_PACKET_STATUS`. Each stimulus
carries the RSSI and SNR the OUT panel reports.

## Airtime

`loraToaMs()` — the SX126x §6.1.4 time-on-air formula, unit-tested against a
known point (SF7/BW125/CR4-5/20 B ≈ 56 ms) and for SF monotonicity. Feeds the
`airtime` meter and is consistent with injected-traffic timing. **Shared with the
SX1262 model** unchanged.

## Panels

- **IN panel** (`InPanel.tsx`): channel-message text, RSSI/SNR fields, Advert /
  Channel / Ack / Noise buttons. Rendered above the OUT panel for any model with
  `onCommand` wired.
- **OUT panel**: generic meter + event-log rendering covers the TX/RX traffic log
  and the Frequency / Last RSSI / Airtime-used meters — no bespoke component
  needed.
- **Config fields** — BW 125/250/500, SF 7/9/11, CR 5/6/8, TX power 14/17/22 —
  poke the model via `setParam` on edit. Four fields hand-wired; the general
  Inspector-config mechanism is a later milestone ([[status]]).

## Host→guest lines

RadioLib level-polls `BUSY` (pin 41) and `DIO9` (pin 42) — no ISR. A guest read
of those pins issues an `Op.GpioRead` frame answered from the host's `pinLevels`
table, fed by `DeviceContext.driveSignal`. The pins the host answers for travel
as an 8-byte bitmask in the `Hello` reply. See [[qemu-fork]].
