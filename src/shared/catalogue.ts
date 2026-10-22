/**
 * Parts the Library offers that are not on the board yet — the design's
 * "Expansion · generic" and "Firmware modules" groups. Placing one adds a
 * fresh {@link PartDefinition} to the board via an `addPart` edit; the id and
 * layout are assigned at placement time so the same catalogue entry can be
 * dropped more than once.
 */

import type { PartCategory, PartDefinition } from './board'

export interface CatalogueEntry {
  /** Stable key, and the id stem for placed instances. */
  key: string
  designator: string
  name: string
  category: PartCategory
  summary: string
  /**
   * The part's own signal names, shown as unbound rows once placed. The
   * placement does NOT turn these into pin bindings — an unbound `pin` value is
   * not a declared board pin and would poison Verify / totals / codegen — so a
   * placed catalogue part starts with no `pins` and the user wires them with
   * the Draw-net tool.
   */
  signals?: string[]
  deviceModel?: string
}

export interface CatalogueGroup {
  title: string
  entries: CatalogueEntry[]
}

export const CATALOGUE: CatalogueGroup[] = [
  {
    title: 'Expansion · generic',
    entries: [
      {
        key: 'led',
        designator: 'D?',
        name: 'LED',
        category: 'interface',
        summary: 'Single indicator LED on one GPIO.',
        signals: ['ANODE'],
        deviceModel: 'pinbench.led'
      },
      {
        key: 'button',
        designator: 'SW?',
        name: 'Momentary button',
        category: 'input',
        summary: 'Push-to-make button, one GPIO, active low.',
        signals: ['IN'],
        deviceModel: 'pinbench.button'
      },
      {
        key: 'neopixel',
        designator: 'LED?',
        name: 'NeoPixel strip',
        category: 'interface',
        summary: 'Addressable WS2812 strip on a single data line (needs RMT).',
        signals: ['DIN']
      },
      {
        key: 'dht22',
        designator: 'U?',
        name: 'DHT22',
        category: 'sensor',
        summary: 'Temperature / humidity sensor, one-wire style single data pin.',
        signals: ['DATA']
      },
      {
        key: 'servo',
        designator: 'M?',
        name: 'Servo',
        category: 'interface',
        summary: 'Hobby servo driven by a 50 Hz PWM (needs LEDC).',
        signals: ['PWM']
      }
    ]
  },
  {
    title: 'Firmware modules',
    entries: [
      {
        key: 'meshcore',
        designator: 'FW',
        name: 'MeshCore stack',
        category: 'interface',
        summary: 'The mesh routing / transport layer the radio driver plugs into.'
      },
      {
        key: 'homepage',
        designator: 'FW',
        name: 'Home page UI',
        category: 'interface',
        summary: 'The screen drawn after radio_init(); owns the display hook.'
      },
      {
        key: 'storage-fs',
        designator: 'FW',
        name: 'Storage / FS',
        category: 'interface',
        summary: 'LittleFS mount over the SD socket or internal flash.'
      }
    ]
  }
]

/**
 * Turn a catalogue entry into a placeable part with a board-unique id and a
 * layout near the given point.
 */
export function instantiateCatalogueEntry(
  entry: CatalogueEntry,
  takenIds: ReadonlySet<string>,
  at: { x: number; y: number }
): PartDefinition {
  let id = entry.key
  for (let n = 2; takenIds.has(id); n += 1) id = `${entry.key}-${n}`
  return {
    id,
    designator: entry.designator,
    name: entry.name,
    category: entry.category,
    ...(entry.deviceModel ? { deviceModel: entry.deviceModel } : {}),
    summary: entry.summary,
    buses: [],
    // No pin bindings — an unbound pin would not be a declared board pin and
    // would corrupt Verify / totals. The user wires the part after placing it.
    pins: [],
    config: [],
    layout: { x: Math.round(at.x), y: Math.round(at.y), width: 150, height: 110 }
  }
}
