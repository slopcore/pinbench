import type { BoardDefinition, PinDefinition, PinCapability } from '@shared/board'

/**
 * A ThinkNode M9 V1.0 board, as fixture data.
 *
 * This is M1's stand-in for the definition file M5 loads from disk, and it is
 * deliberately written against the real `BoardDefinition` types rather than
 * against what today's components happen to need. When M5 lands, this file is
 * deleted and a `.board.json` takes its place — nothing else should have to
 * change.
 *
 * The pin map is the M9's real one where the roadmap records it: SPI SCK 40,
 * MOSI 47, MISO 38, LR_NSS 39, LCD_CS 16, SD_CS 48, I2C 7/6, VDD_PERIPH 18,
 * buzzer 9.
 */

/** ESP32-S3 exposes GPIO0–21 and GPIO26–48; 22–25 do not exist. */
const GPIO_NUMBERS: number[] = [
  ...Array.from({ length: 22 }, (_, index) => index),
  ...Array.from({ length: 23 }, (_, index) => index + 26)
]

const STRAPPING = new Set([0, 3, 45, 46])
const FLASH = new Set([26, 27, 28, 29, 30, 31, 32])
const PSRAM = new Set([33, 34, 35, 36, 37])
const USB = new Set([19, 20])
const ADC = new Set([...Array.from({ length: 20 }, (_, index) => index + 1)])
const TOUCH = new Set([...Array.from({ length: 14 }, (_, index) => index + 1)])

function pin(number: number): PinDefinition {
  const capabilities: PinCapability[] = ['gpio', 'spi', 'i2c', 'uart']
  if (ADC.has(number)) capabilities.push('adc')
  if (TOUCH.has(number)) capabilities.push('touch')
  if (USB.has(number)) capabilities.push('usb')
  if (STRAPPING.has(number)) capabilities.push('strapping')
  if (FLASH.has(number)) capabilities.push('flash')
  if (PSRAM.has(number)) capabilities.push('psram')
  return { id: `GPIO${number}`, label: `IO${number}`, capabilities }
}

export const M9_BOARD: BoardDefinition = {
  schema: 1,
  id: 'thinknode-m9-v1.0',
  name: 'ThinkNode M9 V1.0',
  mcu: 'ESP32-S3-R8',
  vendor: 'Elecrow',
  pins: GPIO_NUMBERS.map(pin),
  buses: [
    {
      id: 'spi0',
      kind: 'spi',
      label: 'SPI0',
      signals: { sck: 'GPIO40', mosi: 'GPIO47', miso: 'GPIO38' },
      clockHz: 20_000_000
    },
    {
      id: 'i2c0',
      kind: 'i2c',
      label: 'I2C0 · sensors',
      signals: { sda: 'GPIO7', scl: 'GPIO6' },
      // The isolated sensor bus is specified at 400 kHz; M10 enforces it.
      clockHz: 400_000
    },
    {
      id: 'i2c1',
      kind: 'i2c',
      label: 'I2C1 · keyboard',
      signals: { sda: 'GPIO4', scl: 'GPIO2' },
      clockHz: 100_000
    },
    {
      id: 'uart0',
      kind: 'uart',
      label: 'UART0 · console',
      signals: { tx: 'GPIO43', rx: 'GPIO44' },
      clockHz: 115_200
    },
    {
      id: 'uart1',
      kind: 'uart',
      label: 'UART1 · GNSS',
      signals: { tx: 'GPIO8', rx: 'GPIO17' },
      clockHz: 9600
    }
  ],
  parts: [
    {
      id: 'u1',
      designator: 'U1',
      name: 'ESP32-S3-R8',
      mpn: 'ESP32-S3-WROOM-1-N16R8',
      category: 'mcu',
      deviceModel: 'esp32s3.soc',
      summary: 'Dual-core Xtensa LX7, 16 MB flash, 8 MB octal PSRAM.',
      buses: ['spi0', 'i2c0', 'i2c1', 'uart0', 'uart1'],
      pins: [],
      config: [
        {
          id: 'psram',
          label: 'PSRAM',
          kind: 'segmented',
          options: ['Off', '2 MB', '8 MB'],
          value: '8 MB'
        },
        {
          id: 'flashMode',
          label: 'Flash mode',
          kind: 'segmented',
          options: ['DIO', 'QIO'],
          value: 'DIO'
        },
        {
          id: 'cpuFreq',
          label: 'CPU clock',
          kind: 'segmented',
          options: ['80', '160', '240'],
          value: '240'
        }
      ],
      layout: { x: 300, y: 210, width: 200, height: 150 }
    },
    {
      id: 'u2',
      designator: 'U2',
      name: 'LR1110 mesh radio',
      mpn: 'LR1110',
      category: 'radio',
      deviceModel: 'semtech.lr1110',
      summary: 'Sub-GHz LoRa transceiver on SPI0, chip select GPIO39.',
      buses: ['spi0'],
      pins: [
        { signal: 'SCK', pin: 'GPIO40' },
        { signal: 'MOSI', pin: 'GPIO47' },
        { signal: 'MISO', pin: 'GPIO38' },
        { signal: 'NSS', pin: 'GPIO39' },
        { signal: 'BUSY', pin: 'GPIO41' },
        { signal: 'IRQ', pin: 'GPIO42' },
        { signal: 'NRESET', pin: 'GPIO21' }
      ],
      config: [
        {
          id: 'bw',
          label: 'Bandwidth',
          kind: 'segmented',
          options: ['125', '250', '500'],
          value: '250'
        },
        {
          id: 'sf',
          label: 'Spreading factor',
          kind: 'segmented',
          options: ['7', '9', '11'],
          value: '11'
        },
        { id: 'cr', label: 'Coding rate', kind: 'segmented', options: ['5', '6', '8'], value: '5' },
        {
          id: 'txPower',
          label: 'TX power',
          kind: 'number',
          value: 22,
          min: -9,
          max: 22,
          step: 1,
          unit: 'dBm'
        }
      ],
      layout: { x: 60, y: 200, width: 170, height: 120 }
    },
    {
      id: 'u3',
      designator: 'U3',
      name: '2.4" LCD',
      mpn: 'ST7789V',
      category: 'display',
      deviceModel: 'sitronix.st7789',
      summary: '320×240 IPS panel on SPI0, chip select GPIO16.',
      buses: ['spi0'],
      pins: [
        { signal: 'SCK', pin: 'GPIO40' },
        { signal: 'MOSI', pin: 'GPIO47' },
        { signal: 'CS', pin: 'GPIO16' },
        { signal: 'DC', pin: 'GPIO15' },
        { signal: 'RST', pin: 'GPIO14' },
        { signal: 'BL', pin: 'GPIO13' },
        { signal: 'TE', pin: 'GPIO46' }
      ],
      config: [
        { id: 'backlight', label: 'Backlight', kind: 'toggle', value: true },
        {
          id: 'rotation',
          label: 'Rotation',
          kind: 'segmented',
          options: ['0°', '90°', '180°', '270°'],
          value: '90°'
        },
        {
          id: 'scale',
          label: 'Panel zoom',
          kind: 'segmented',
          options: ['1×', '2×', '3×'],
          value: '2×'
        }
      ],
      layout: { x: 570, y: 60, width: 210, height: 160 }
    },
    {
      id: 'u4',
      designator: 'U4',
      name: 'microSD socket',
      category: 'storage',
      deviceModel: 'generic.sdcard',
      summary: 'SPI-mode card on SPI0, chip select GPIO48.',
      buses: ['spi0'],
      pins: [
        { signal: 'SCK', pin: 'GPIO40' },
        { signal: 'MOSI', pin: 'GPIO47' },
        { signal: 'MISO', pin: 'GPIO38' },
        { signal: 'CS', pin: 'GPIO48' }
      ],
      config: [
        { id: 'inserted', label: 'Card inserted', kind: 'toggle', value: true },
        {
          id: 'capacity',
          label: 'Capacity',
          kind: 'segmented',
          options: ['2 GB', '8 GB', '32 GB'],
          value: '8 GB'
        }
      ],
      layout: { x: 570, y: 260, width: 190, height: 110 }
    },
    {
      id: 'u5',
      designator: 'U5',
      name: 'CH340K USB-UART',
      mpn: 'CH340K',
      category: 'interface',
      deviceModel: 'wch.ch340k',
      summary: 'Console bridge on UART0, with the auto-reset circuit on GPIO0.',
      buses: ['uart0'],
      pins: [
        { signal: 'TXD', pin: 'GPIO43' },
        { signal: 'RXD', pin: 'GPIO44' },
        { signal: 'BOOT', pin: 'GPIO0' }
      ],
      config: [
        {
          id: 'baud',
          label: 'Baud',
          kind: 'segmented',
          options: ['9600', '115200', '921600'],
          value: '115200'
        },
        { id: 'echo', label: 'Local echo', kind: 'toggle', value: false }
      ],
      layout: { x: 300, y: 60, width: 190, height: 110 }
    },
    {
      id: 'u6',
      designator: 'U6',
      name: 'ATGM336H GNSS',
      mpn: 'ATGM336H-5N',
      category: 'sensor',
      deviceModel: 'zhongke.atgm336h',
      summary: 'NMEA receiver on UART1 at 9600 baud, 1 PPS on GPIO3.',
      buses: ['uart1'],
      pins: [
        { signal: 'TXD', pin: 'GPIO17' },
        { signal: 'RXD', pin: 'GPIO8' },
        { signal: 'PPS', pin: 'GPIO3' },
        { signal: 'EN', pin: 'GPIO20' }
      ],
      config: [
        {
          id: 'scenario',
          label: 'Fix scenario',
          kind: 'segmented',
          options: ['Open sky', 'Urban canyon', 'No fix'],
          value: 'Open sky'
        },
        {
          id: 'rate',
          label: 'Update rate',
          kind: 'segmented',
          options: ['1 Hz', '5 Hz', '10 Hz'],
          value: '1 Hz'
        }
      ],
      layout: { x: 60, y: 380, width: 170, height: 110 }
    },
    {
      id: 'u7',
      designator: 'U7',
      name: 'Sensor cluster',
      mpn: 'BME280 + QMC5883L',
      category: 'sensor',
      deviceModel: 'pinbench.i2c-cluster',
      summary: 'Isolated 400 kHz I2C0 bus, shared interrupt on GPIO5.',
      buses: ['i2c0'],
      pins: [
        { signal: 'SDA', pin: 'GPIO7' },
        { signal: 'SCL', pin: 'GPIO6' },
        { signal: 'INT', pin: 'GPIO5' }
      ],
      config: [
        {
          id: 'temperature',
          label: 'Temperature',
          kind: 'number',
          value: 21,
          min: -40,
          max: 85,
          step: 1,
          unit: '°C'
        },
        {
          id: 'humidity',
          label: 'Humidity',
          kind: 'number',
          value: 48,
          min: 0,
          max: 100,
          step: 1,
          unit: '%'
        },
        {
          id: 'pressure',
          label: 'Pressure',
          kind: 'number',
          value: 1013,
          min: 300,
          max: 1100,
          step: 1,
          unit: 'hPa'
        }
      ],
      layout: { x: 300, y: 400, width: 200, height: 120 }
    },
    {
      id: 'u8',
      designator: 'U8',
      name: 'Keyboard coprocessor',
      mpn: 'ESP32-S2-MINI',
      category: 'input',
      deviceModel: 'pinbench.kbd-coprocessor',
      summary: '4-row QWERTY matrix reported over I2C1, interrupt on GPIO1.',
      buses: ['i2c1'],
      pins: [
        { signal: 'SDA', pin: 'GPIO4' },
        { signal: 'SCL', pin: 'GPIO2' },
        { signal: 'IRQ', pin: 'GPIO1' }
      ],
      config: [
        {
          id: 'layout',
          label: 'Layout',
          kind: 'segmented',
          options: ['QWERTY', 'AZERTY'],
          value: 'QWERTY'
        },
        { id: 'repeat', label: 'Key repeat', kind: 'toggle', value: true }
      ],
      layout: { x: 570, y: 410, width: 210, height: 120 }
    },
    {
      id: 'u9',
      designator: 'U9',
      name: 'Power & buzzer',
      category: 'power',
      deviceModel: 'pinbench.power',
      summary: 'Battery sense, USB-C detect, VDD_PERIPH rail on GPIO18, buzzer on GPIO9.',
      buses: [],
      pins: [
        { signal: 'VDD_PERIPH', pin: 'GPIO18' },
        { signal: 'BUZZER', pin: 'GPIO9' },
        { signal: 'VBAT_ADC', pin: 'GPIO10' },
        { signal: 'USB_DET', pin: 'GPIO11' },
        { signal: 'CHG_STAT', pin: 'GPIO12' }
      ],
      config: [
        {
          id: 'battery',
          label: 'Battery',
          kind: 'number',
          value: 78,
          min: 0,
          max: 100,
          step: 1,
          unit: '%'
        },
        { id: 'usb', label: 'USB-C connected', kind: 'toggle', value: true },
        { id: 'rail', label: 'VDD_PERIPH', kind: 'toggle', value: true }
      ],
      layout: { x: 60, y: 60, width: 170, height: 100 }
    }
  ],
  nets: [
    {
      id: 'net-sck',
      label: 'SPI0_SCK',
      bus: 'spi0',
      nodes: ['GPIO40', 'u2:SCK', 'u3:SCK', 'u4:SCK']
    },
    {
      id: 'net-mosi',
      label: 'SPI0_MOSI',
      bus: 'spi0',
      nodes: ['GPIO47', 'u2:MOSI', 'u3:MOSI', 'u4:MOSI']
    },
    { id: 'net-miso', label: 'SPI0_MISO', bus: 'spi0', nodes: ['GPIO38', 'u2:MISO', 'u4:MISO'] },
    { id: 'net-lr-nss', label: 'LR_NSS', bus: 'spi0', nodes: ['GPIO39', 'u2:NSS'] },
    { id: 'net-lcd-cs', label: 'LCD_CS', bus: 'spi0', nodes: ['GPIO16', 'u3:CS'] },
    { id: 'net-sd-cs', label: 'SD_CS', bus: 'spi0', nodes: ['GPIO48', 'u4:CS'] },
    { id: 'net-i2c0-sda', label: 'I2C0_SDA', bus: 'i2c0', nodes: ['GPIO7', 'u7:SDA'] },
    { id: 'net-i2c0-scl', label: 'I2C0_SCL', bus: 'i2c0', nodes: ['GPIO6', 'u7:SCL'] },
    { id: 'net-i2c1-sda', label: 'I2C1_SDA', bus: 'i2c1', nodes: ['GPIO4', 'u8:SDA'] },
    { id: 'net-i2c1-scl', label: 'I2C1_SCL', bus: 'i2c1', nodes: ['GPIO2', 'u8:SCL'] },
    {
      id: 'net-console',
      label: 'UART0_CONSOLE',
      bus: 'uart0',
      nodes: ['GPIO43', 'GPIO44', 'u5:TXD', 'u5:RXD']
    },
    { id: 'net-vdd-periph', label: 'VDD_PERIPH', nodes: ['GPIO18', 'u9:VDD_PERIPH'] }
  ],
  emulator: { machine: 'esp32s3', psramSize: '8M', psramOctal: true },
  canvas: { width: 840, height: 590 }
}
