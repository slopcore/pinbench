# Board definitions

Each `*.board.json` file here is one board, loaded and fully validated at
runtime by `src/main/board.ts` (`loadBoard`) against `parseBoard` in
`src/shared/board.ts`. The file is read with `fs`, never `import`ed — editing a
definition changes what PinBench shows on the next launch without a rebuild.

`parseBoard` fails loud, naming the offending field path, on any of:

- an unknown `schema` (only `1`)
- a missing or wrongly-typed identity field
- a duplicate pin / bus / part / net id
- a bus signal, part pin binding, part bus, or net that references something
  the board does not declare
- a net endpoint `partId:signal` that resolves to no real part signal
- anything other than exactly one `mcu` part

The renderer never sees a board file — the main process hands the parsed
`BoardDefinition` to both the device host and, over IPC, the renderer.

## `thinknode-m9-v1.0` — pin map provenance

The roadmap records these numbers directly, and they are authoritative:

| Signal                                | Pin               |
| ------------------------------------- | ----------------- |
| SPI0 SCK / MOSI / MISO                | 40 / 47 / 38      |
| LR_NSS / LR_BUSY / LR_IRQ / LR_NRESET | 39 / 41 / 42 / 45 |
| LCD_CS / SD_CS                        | 16 / 48           |
| I2C0 (sensors) SDA / SCL              | 7 / 6             |
| I2C1 (keyboard) SDA / SCL             | 20 / 21           |
| KEY_INT (keyboard wake)               | 12                |
| GNSS UART1                            | 2 / 3             |
| GNSS 1PPS / GPS_EN                    | 4 / 11            |
| BAT_ADC                               | 13                |
| VDD_PERIPH / BUZZER                   | 18 / 9            |

`GPIO45` (`LR_NRESET`) is a strapping pin — that is real M9 hardware, and it
gives M11's strapping-pin rule a genuine target. `I2C1` on `GPIO20/21` means the
board has no native USB; the console is bridged through the CH340K on `UART0`.

The rest were invented for the M1 shell and kept only where they do not
collide: the LCD's `DC` (15), `RST` (14), `BL` (10) and `TE` (46); the sensor
cluster's shared `INT` (5); the CH340K's `BOOT` (0); the power block's
`USB_DET` (8) and `CHG_STAT` (17). Treat these as placeholders until the
matching device milestone (M6, M9, M10) transcribes the real schematic.

## `heltec-wireless-paper-v1.1` — pin map provenance

Transcribed from the MeshCore checkout's own
`variants/heltec_wireless_paper/platformio.ini` (`[Heltec_Wireless_Paper_base]`
`build_flags`) — every pin below is a `-D` in that file, not a guess:

| Signal                                 | Pin             |
| -------------------------------------- | --------------- |
| Radio SPI SCLK / MOSI / MISO           | 9 / 10 / 11     |
| SX1262 NSS / BUSY / DIO1 / RESET       | 8 / 13 / 14 / — |
| SX1262 TX-LED (`P_LORA_TX_LED`)        | 18              |
| Display SPI SCLK / MOSI                | 3 / 2           |
| E-ink CS / BUSY / DC / RST             | 4 / 7 / 5 / 6   |
| USER_BTN                               | 0               |
| VEXT_EN (peripheral power, active-low) | 45              |
| VBAT_READ / ADC_CTRL                   | 20 / 19         |

`RESET` is `RADIOLIB_NC` — the SX1262 has no wired hardware reset on this board,
so `u2` has no `NRESET` binding and the model resets only on power-on and the
RadioLib soft path. The radio and the e-ink panel sit on **separate SPI buses**
(`spi-radio`, `spi-disp`) — the M9 put every SPI peripheral on one shared bus,
so this is the first board that exercises two. The e-ink bus has no `miso`
signal: the panel is write-only. `GPIO0` (`USER_BTN`), `GPIO3` (e-ink `SCLK`)
and `GPIO45` (`VEXT_EN`) are strapping pins — real Heltec hardware, and genuine
targets for M11's strapping-pin rule; `⌘B` Verify on this board is clean bar
those three `note` rows. `TX_LED` on `GPIO18` is bound once, to `u2` (the radio
owns it, `P_LORA_TX_LED`); the power block only reads battery and the rail.

SX1262 build flags carried into `u2.deviceOptions`: `dio2RfSwitch`
(`SX126X_DIO2_AS_RF_SWITCH=true`) and `dio3TcxoVoltage` 1.8 V
(`SX126X_DIO3_TCXO_VOLTAGE=1.8`). The e-ink `u3.deviceOptions.busyActiveLow`
records that the Heltec Wireless Paper V1.1 panel's UC8151 controller signals
busy **LOW** — `heltec-eink-modules` resolves `EInkDisplay_WirelessPaperV1_1` to
its `LCMEN2R13EFC1` driver (connector HINK-E0213A162), whose `wait()` loops
`while(digitalRead(pin_busy) == LOW)`. This is a different controller family
from the SSD1680 the earlier Wireless Paper V1 panel used. The radio
model (`semtech.sx1262`) answers RadioLib's version-register read with the
string `SX1261` — RadioLib's `SX1262` class shares the SX1261 `chipType`, and
`findChip()` `strncmp`s that, not what the silicon really reports.

The MCU is a plain ESP32-S3 (`esp32-s3-devkitc-1`, 8 MB flash, **no PSRAM**), so
`emulator` carries only `machine` and `flashSize: "8M"` — no `psramSize` /
`psramOctal`. Flash mode is DIO for the same reason as the M9 (ADR 0001's
QIO-crash finding); the board default is QIO and the emulator build overrides it.

The `esp32s3.soc`, `pinbench.power` and `pinbench.button` model ids are
referenced but not yet registered — a visible no-op in the device registry, the
same as the M9's unimplemented parts before their milestones.

**WiFi is out of scope.** The build PinBench targets for this board is
`Heltec_Wireless_Paper_repeater` (MeshCore `simple_repeater`) — a LoRa-only
mesh repeater that uses neither WiFi nor BLE. The Heltec weather-station fork
fetches over WiFi, which the QEMU fork does not emulate; that build will not run
end to end under PinBench and there is no stub for it. If a WiFi-dependent
Heltec build is ever wanted here, it is its own piece of work.
