/**
 * The shape a board definition arrives in.
 *
 * M1 has no board loader and no emulator: the Library, Inspector, Canvas and
 * status bar all render from a fixture that already implements these types.
 * M5 replaces the fixture with a validated definition file loaded from disk —
 * and, per the milestone's "watch for", nothing in `src/` is allowed to know
 * that the M1 data came from a fixture. If a component needs a field, it goes
 * here first.
 */

/** A physical pin on the MCU package. */
export interface PinDefinition {
  /** Stable identifier used by nets and bindings, e.g. `GPIO40`. */
  id: string
  /** Human label shown on the canvas and in the Inspector, e.g. `IO40`. */
  label: string
  /** Pin capabilities, used later by the M11 pin-map rule engine. */
  capabilities: PinCapability[]
}

export type PinCapability =
  'gpio' | 'adc' | 'touch' | 'spi' | 'i2c' | 'uart' | 'usb' | 'strapping' | 'psram' | 'flash'

export type BusKind = 'spi' | 'i2c' | 'uart' | 'onewire'

export interface BusDefinition {
  id: string
  kind: BusKind
  label: string
  /** Bus-role to pin id, e.g. `{ sck: 'GPIO40', mosi: 'GPIO47' }`. */
  signals: Record<string, string>
  /** Nominal clock in hertz, where the board fixes one. */
  clockHz?: number
}

/** Library grouping — the collapsible sections down the left-hand panel. */
export type PartCategory =
  'mcu' | 'radio' | 'display' | 'storage' | 'sensor' | 'input' | 'power' | 'interface'

export interface PartPinBinding {
  /** The part's own signal name, e.g. `NSS`. */
  signal: string
  /** The board pin it lands on, e.g. `GPIO39`. */
  pin: string
}

/**
 * A configurable field the Inspector renders for a part. M12 wires these to
 * live device-model state; M1 renders them and records the value locally.
 */
export type PartConfigField =
  | { id: string; label: string; kind: 'segmented'; options: string[]; value: string }
  | { id: string; label: string; kind: 'toggle'; value: boolean }
  | { id: string; label: string; kind: 'text'; value: string; unit?: string }
  | {
      id: string
      label: string
      kind: 'number'
      value: number
      min: number
      max: number
      step: number
      unit?: string
    }

export interface PartDefinition {
  id: string
  /** Reference designator as drawn on the canvas, e.g. `U2`. */
  designator: string
  name: string
  /** Manufacturer part number, shown as the Inspector subtitle. */
  mpn?: string
  category: PartCategory
  /** Device-model id resolved by the plugin registry from M4 onward. */
  deviceModel?: string
  summary: string
  buses: string[]
  pins: PartPinBinding[]
  config: PartConfigField[]
  /** Canvas layout hint, in board-definition units. */
  layout: { x: number; y: number; width: number; height: number }
}

export interface NetDefinition {
  id: string
  label: string
  /** Bus this net belongs to, when it is part of one. */
  bus?: string
  /** Pin ids and `partId:signal` endpoints joined by this net. */
  nodes: string[]
}

/**
 * How the emulator should be launched for this board. M2 hardcoded these in
 * `EmulatorSupervisor`; from M3 they travel with the board definition so the
 * M9's octal PSRAM and a future board's differing memory are both just data.
 * Without `psramSize` there is silently no PSRAM — the machine's
 * `default_ram_size` is 0.
 */
export interface EmulatorTarget {
  /** QEMU `-machine`. Defaults to `esp32s3`. */
  machine?: string
  /** QEMU `-m`, e.g. `8M`. Omit for a part with no PSRAM. */
  psramSize?: string
  /** Octal PSRAM parts (the M9's ESP32-S3-R8) need `ssi_psram.is_octal=true`. */
  psramOctal?: boolean
}

export interface BoardDefinition {
  /** Definition schema version — M5 validates against it. */
  schema: 1
  id: string
  name: string
  /** e.g. `ESP32-S3-R8`. */
  mcu: string
  vendor: string
  pins: PinDefinition[]
  buses: BusDefinition[]
  parts: PartDefinition[]
  nets: NetDefinition[]
  emulator: EmulatorTarget
  canvas: {
    /** Board outline in the same units as `PartDefinition.layout`. */
    width: number
    height: number
  }
}

/** The counts in the canvas footer. Computed, never written down. */
export interface BoardTotals {
  parts: number
  nets: number
  assignedGpio: number
}

export function boardTotals(board: BoardDefinition): BoardTotals {
  const assigned = new Set<string>()
  for (const part of board.parts) {
    for (const binding of part.pins) assigned.add(binding.pin)
  }
  return {
    parts: board.parts.length,
    nets: board.nets.length,
    assignedGpio: assigned.size
  }
}

export function partsByCategory(board: BoardDefinition): Map<PartCategory, PartDefinition[]> {
  const grouped = new Map<PartCategory, PartDefinition[]>()
  for (const part of board.parts) {
    const bucket = grouped.get(part.category)
    if (bucket) bucket.push(part)
    else grouped.set(part.category, [part])
  }
  return grouped
}

export function findPart(board: BoardDefinition, partId: string): PartDefinition | undefined {
  return board.parts.find((part) => part.id === partId)
}

export const CATEGORY_LABELS: Record<PartCategory, string> = {
  mcu: 'Processor',
  radio: 'Radio',
  display: 'Display',
  storage: 'Storage',
  sensor: 'Sensors',
  input: 'Input',
  power: 'Power',
  interface: 'Interface'
}
