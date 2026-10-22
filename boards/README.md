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

The `esp32s3.soc` and `pinbench.power` model ids are referenced but not yet
registered — a visible no-op in the device registry, the same as the M9's
unimplemented parts before their milestones. `pinbench.button` provides the
button device model for SW1 on GPIO0.

The `firmware` hint (`{ "env": "Heltec_Wireless_Paper_repeater", "envMatch":
"heltec_wireless_paper" }`) is what makes "open the MeshCore folder, hit ▶"
build the right thing: MeshCore globs ~500 `[env:*]` from `variants/*/`, and
the first alphabetically is `Ebyte_EoRa-S3_Repeater`. `pickFirmwareEnv` takes
`env` when the opened folder defines it, else the first name containing
`envMatch`, else `envs[0]`.

**WiFi is out of scope.** The build PinBench targets for this board is
`Heltec_Wireless_Paper_repeater` (MeshCore `simple_repeater`) — a LoRa-only
mesh repeater that uses neither WiFi nor BLE. The Heltec weather-station fork
fetches over WiFi, which the QEMU fork does not emulate; that build will not run
end to end under PinBench and there is no stub for it. If a WiFi-dependent
Heltec build is ever wanted here, it is its own piece of work.

## `thinknode-m1-v1.0` — pin map provenance

Transcribed from the MeshCore / FieldMesh `variants/thinknode_m1/` (`platformio.ini`, `variant.h`, `target.cpp`) and the Elecrow ThinkNode M1 hardware specification (nRF52840 + SX1262 + 1.54" E-Paper display):

| Signal                             | Pin (nRF52)       |
| ---------------------------------- | ----------------- |
| LoRa SPI SCLK / MOSI / MISO        | 19 / 22 / 23      |
| SX1262 NSS / BUSY / DIO1 / RESET   | 24 / 17 / 20 / 25 |
| SX1262 TX-LED (`P_LORA_TX_LED`)    | 13                |
| E-ink Display CS / DC / RST / BUSY | 28 / 29 / 32 / 33 |
| GNSS UART1 TX / RX / PPS / EN      | 30 / 31 / 34 / 35 |
| Battery sense / PWR_EN / SX126X_EN | 4 / 12 / 37       |
| USER_BTN (SW1)                     | 39                |

The MCU is a Nordic nRF52840 (RAK4631-compatible pin mapping). The radio and 1.54" e-paper display share SPI0 with distinct chip selects (`GPIO24` for LoRa NSS, `GPIO28` for Display CS).

## `waveshare-esp32-c6-touch-lcd-1.28` — pin map provenance

Transcribed from Waveshare's own `HARDWARE_REFERENCE.md` in
[`waveshareteam/ESP32-C6-Touch-LCD-1.28`](https://github.com/waveshareteam/ESP32-C6-Touch-LCD-1.28),
which states it is cross-checked against that repo's schematic
(`hardware/schematics/ESP32-C6-Touch-LCD-1.28.pdf`) and BSP pin definitions.
The LCD pins also match `examples/Arduino-v3.2.1/07_LVGL_Demo/GC9A01.cpp`.

| Signal                          | Pin              |
| ------------------------------- | ---------------- |
| SPI2 SCK / MOSI / MISO          | 11 / 21 / 22     |
| GC9A01 CS / DC / RST / BL       | 10 / 19 / 20 / 7 |
| TF card CS                      | 15               |
| I2C SDA / SCL (touch, IMU, RTC) | 18 / 8           |
| CST816S INT / RST (`0x15`)      | 4 / 23           |
| QMI8658 INT1 / INT2 (`0x6B`)    | 5 / 4            |
| PCF85063ATL INT (`0x51`)        | 6                |
| BAT_ADC (200K/100K divider)     | 0                |
| BOOT                            | 9                |
| USB D- / D+                     | 12 / 13          |
| UART0 TX / RX (expansion)       | 16 / 17          |

Only the GPIOs the reference lists are declared: `GPIO14` is not bonded out on
this board, and 24–30 belong to the flash. No pin has `touch` (the C6 has no
capacitive-touch peripheral); `adc` is `GPIO0`–`6` (ADC1). Strapping pins are the
C6's own — `GPIO4` (MTMS), `GPIO5` (MTDI), `GPIO8`, `GPIO9`, `GPIO15` — and five
of them are in use on this board, so `⌘B` Verify lists those `note` rows.
`pinExceptions` declares the board's two deliberate double-binds: `GPIO4` carries
both the touch INT and IMU INT2, and `GPIO23` is both touch reset and the
charger's `BC_State`.

The panel is a **GC9A01**, modelled as `galaxycore.gc9a01`: the ST7789 state
machine with a 240×240 GRAM, Waveshare's vendor init opcodes, and a
normally-black glass (the driver always sends `INVON`, and the frame reports
true colour under it). The renderer masks it round, and clicking or dragging on
it drives the touch controller, `hynitron.cst816s` (I2C 0x15). QMI8658 and
PCF85063 have no device model yet — they NACK on the bus; `esp32c6.soc`,
`generic.sdcard` and `pinbench.power` are unregistered ids like on the other
boards.

**Emulation.** `emulator.machine: "esp32c6"` runs on `qemu-system-riscv32`
(QEMU pinned to the esp-develop commit that adds the C6 machine), with the C6
overlay in `qemu/`: GPIO forwarding + interrupts, a DMA-capable GP-SPI2 (IDF
`spi_master` / `esp_lcd`, which Waveshare's panel driver uses) and an I2C0
master bridged to the device host. `src/main/c6-live.test.ts` boots
`test/firmware/waveshare-c6-lcd` — Waveshare's own GC9A01 and CST816S drivers —
and checks the painted frame's pixels and an injected tap.

**Building.** ESP32-C6 needs Arduino-ESP32 3.x, i.e. the pioarduino platform
(54.03.21 is the newest PlatformIO Core 6.1 can install). Build & flash runs a
pioarduino env in its own core dir (`~/.platformio-pioarduino`), because
pioarduino's installer replaces the official platform's shared packages. Its
esptool 5.0.0-dev1 breaks under click ≥ 8.2, so a project pins
`tool-esptoolpy @ …/pioarduino/esptool/releases/download/v5.1.0/esptool.zip`
in `platform_packages`, as the fixture does. There is no `firmware` hint: the
board has no LoRa radio, so MeshCore has no variant for it.
