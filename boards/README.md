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
