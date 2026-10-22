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
  /**
   * The SoC peripheral instance behind this bus, e.g. `1` for UART1. Only
   * UARTs use it: the emulator hands UART1's byte stream to the part on the
   * `uart` bus with `controller: 1`. Omit where the instance does not matter.
   */
  controller?: number
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

/**
 * Where the firmware talks to this part. Shown as the Inspector's "Firmware
 * hook" card; `file`/`line` drive its "Reveal in source" jump. All fields but
 * `symbol` are optional so a board can name a hook it cannot yet pin to a line.
 */
export interface FirmwareHook {
  /** The call the firmware makes into this part, e.g. `Lr1110::begin()`. */
  symbol: string
  /** Source file for the reveal action, relative to the PlatformIO project root. */
  file?: string
  /** 1-based line within `file`, when known. */
  line?: number
  /** One line on what the hook does. */
  note?: string
}

export interface PartDefinition {
  id: string
  /** Reference designator as drawn on the canvas, e.g. `U2`. */
  designator: string
  name: string
  /** Manufacturer part number, shown as the Inspector subtitle. */
  mpn?: string
  category: PartCategory
  /** The firmware entry point for this part — Inspector "Firmware hook" card. */
  firmwareHook?: FirmwareHook
  /** Device-model id resolved by the plugin registry from M4 onward. */
  deviceModel?: string
  /**
   * Fixed construction options for the device model — board-hardware facts, not
   * user settings (which live in `config`). E.g. the M9's ST7789 backlight is
   * wired active-low, so `u3` sets `{ backlightActiveHigh: false }`. Passed
   * verbatim to the model factory; the model validates its own shape.
   */
  deviceOptions?: Record<string, unknown>
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
  /**
   * Total flash-image size, e.g. `16M`. This is the *flash* size, unrelated to
   * PSRAM: the M9 has 8 MB PSRAM but 16 MB flash and a `default_16MB.csv`
   * partition table whose entries run past 8 MB. Omit to fall back to the
   * spike's 8 MB. Used only to size the merged image Build & flash produces.
   */
  flashSize?: string
  /**
   * Guest networking. `'user'` gives the board an emulated OpenCores Ethernet
   * NIC on QEMU's slirp stack — NAT'd pass-through to the host network — for
   * firmware built with `PINBENCH_EMULATED_NET`. Omit (or `'none'`) for the
   * usual no-network launch. See docs/features/emulated-network.md.
   */
  network?: 'none' | 'user'
}

/**
 * Which PlatformIO build environment this hardware profile expects. A repo like
 * MeshCore ships hundreds of `[env:...]` entries under per-variant
 * `platformio.ini` files; the first one alphabetically is almost never the one
 * that matches the board the user picked. With this hint, opening a source
 * folder auto-selects the right env so "open the firmware, hit play" just works.
 */
export interface FirmwareHint {
  /** Exact env name to select when the opened folder defines it. */
  env?: string
  /**
   * Fallback when `env` is absent or not in the folder: the first env whose
   * name contains this substring (case-insensitive), e.g. `heltec_wireless_paper`.
   */
  envMatch?: string
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
  /** Which PlatformIO env this profile builds. Optional; see {@link FirmwareHint}. */
  firmware?: FirmwareHint
  /**
   * Pin ids where a double-bind is intentional and must not raise a `warn` from
   * the M11 "Verify pin map" rule engine — only a `note`. The M9's `GPIO12`
   * carries both `KEY_INT` and `ESP32_WAKEUP` on purpose (M8's watch-for).
   */
  pinExceptions?: string[]
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

/**
 * The subset of `envs` compatible with this board, per the board's
 * {@link FirmwareHint}: every env whose name contains `envMatch`
 * (case-insensitive). A soft filter — if the hint is absent or narrows the list
 * to nothing (a repo whose env names do not encode the board), every env is
 * returned. Order is preserved. The session bar's env dropdown shows this by
 * default, with an "All envs" escape hatch.
 */
export function matchFirmwareEnvs(envs: readonly string[], hint?: FirmwareHint): string[] {
  if (!hint?.envMatch) return [...envs]
  const needle = hint.envMatch.toLowerCase()
  const hits = envs.filter((env) => env.toLowerCase().includes(needle))
  return hits.length > 0 ? hits : [...envs]
}

/**
 * The build env to select for a freshly opened source folder: the board's
 * {@link FirmwareHint} `env` if it resolves against `envs`, else the first
 * compatible env ({@link matchFirmwareEnvs}), else null. Pure — the folder-open
 * and launch-reopen paths both route through here.
 */
export function pickFirmwareEnv(envs: readonly string[], hint?: FirmwareHint): string | null {
  if (hint?.env && envs.includes(hint.env)) return hint.env
  return matchFirmwareEnvs(envs, hint)[0] ?? null
}

/**
 * Raised when a board definition on disk is malformed. Unlike `normaliseWorkspace`
 * and `normaliseSession`, which coerce a bad file into the defaults so the app
 * still launches, a board definition fails loud: a silently-coerced pin map is
 * exactly the "silent zeros will cost you days" trap the device milestones warn
 * about. The `path` names the offending field.
 */
export class BoardValidationError extends Error {
  constructor(
    readonly path: string,
    detail: string
  ) {
    super(`${path}: ${detail}`)
    this.name = 'BoardValidationError'
  }
}

const PIN_CAPABILITIES: readonly PinCapability[] = [
  'gpio',
  'adc',
  'touch',
  'spi',
  'i2c',
  'uart',
  'usb',
  'strapping',
  'psram',
  'flash'
]
const BUS_KINDS: readonly BusKind[] = ['spi', 'i2c', 'uart', 'onewire']
const PART_CATEGORIES: readonly PartCategory[] = [
  'mcu',
  'radio',
  'display',
  'storage',
  'sensor',
  'input',
  'power',
  'interface'
]
const CONFIG_KINDS = ['segmented', 'toggle', 'text', 'number'] as const

function fail(path: string, detail: string): never {
  throw new BoardValidationError(path, detail)
}

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'expected an object')
  }
  return value as Record<string, unknown>
}

function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected an array')
  return value
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'expected a non-empty string')
  return value
}

function num(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'expected a finite number')
  return value
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(path, `expected one of ${allowed.join(', ')}`)
  }
  return value as T
}

function unique(ids: string[], path: string): void {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) fail(path, `duplicate id "${id}"`)
    seen.add(id)
  }
}

/**
 * Parse and fully validate a board definition read from disk. Throws
 * `BoardValidationError` on the first problem, naming the field. The
 * cross-reference checks — part pins resolve to declared pins, buses exist,
 * net endpoints resolve to a real part signal — were consistency assertions
 * living in the M1 fixture's test file; they belong here, where every board
 * that loads is held to them.
 */
export function parseBoard(input: unknown): BoardDefinition {
  const root = obj(input, 'board')
  if (root['schema'] !== 1) fail('board.schema', 'must be 1')

  const id = str(root['id'], 'board.id')
  const name = str(root['name'], 'board.name')
  const mcu = str(root['mcu'], 'board.mcu')
  const vendor = str(root['vendor'], 'board.vendor')

  const pins: PinDefinition[] = arr(root['pins'], 'board.pins').map((raw, i) => {
    const p = obj(raw, `board.pins[${i}]`)
    return {
      id: str(p['id'], `board.pins[${i}].id`),
      label: str(p['label'], `board.pins[${i}].label`),
      capabilities: arr(p['capabilities'], `board.pins[${i}].capabilities`).map((c, j) =>
        oneOf(c, PIN_CAPABILITIES, `board.pins[${i}].capabilities[${j}]`)
      )
    }
  })
  unique(
    pins.map((p) => p.id),
    'board.pins'
  )
  const pinIds = new Set(pins.map((p) => p.id))

  const buses: BusDefinition[] = arr(root['buses'], 'board.buses').map((raw, i) => {
    const b = obj(raw, `board.buses[${i}]`)
    const signalsRaw = obj(b['signals'], `board.buses[${i}].signals`)
    const signals: Record<string, string> = {}
    for (const [role, target] of Object.entries(signalsRaw)) {
      const pin = str(target, `board.buses[${i}].signals.${role}`)
      if (!pinIds.has(pin)) {
        fail(`board.buses[${i}].signals.${role}`, `"${pin}" is not a declared pin`)
      }
      signals[role] = pin
    }
    const bus: BusDefinition = {
      id: str(b['id'], `board.buses[${i}].id`),
      kind: oneOf(b['kind'], BUS_KINDS, `board.buses[${i}].kind`),
      label: str(b['label'], `board.buses[${i}].label`),
      signals
    }
    if (b['clockHz'] !== undefined) bus.clockHz = num(b['clockHz'], `board.buses[${i}].clockHz`)
    if (b['controller'] !== undefined) {
      bus.controller = num(b['controller'], `board.buses[${i}].controller`)
    }
    return bus
  })
  unique(
    buses.map((b) => b.id),
    'board.buses'
  )
  const busIds = new Set(buses.map((b) => b.id))

  const parts: PartDefinition[] = arr(root['parts'], 'board.parts').map((raw, i) => {
    const p = obj(raw, `board.parts[${i}]`)
    const partId = str(p['id'], `board.parts[${i}].id`)
    const pins = arr(p['pins'], `board.parts[${i}].pins`).map((raw2, j) => {
      const binding = obj(raw2, `board.parts[${i}].pins[${j}]`)
      const pin = str(binding['pin'], `board.parts[${i}].pins[${j}].pin`)
      if (!pinIds.has(pin)) {
        fail(`board.parts[${i}].pins[${j}].pin`, `"${pin}" is not a declared pin`)
      }
      return { signal: str(binding['signal'], `board.parts[${i}].pins[${j}].signal`), pin }
    })
    const partBuses = arr(p['buses'], `board.parts[${i}].buses`).map((b, j) => {
      const busId = str(b, `board.parts[${i}].buses[${j}]`)
      if (!busIds.has(busId))
        fail(`board.parts[${i}].buses[${j}]`, `"${busId}" is not a declared bus`)
      return busId
    })
    const config = arr(p['config'], `board.parts[${i}].config`).map((raw2, j) => {
      const f = obj(raw2, `board.parts[${i}].config[${j}]`)
      oneOf(f['kind'], CONFIG_KINDS, `board.parts[${i}].config[${j}].kind`)
      str(f['id'], `board.parts[${i}].config[${j}].id`)
      str(f['label'], `board.parts[${i}].config[${j}].label`)
      return f as unknown as PartConfigField
    })
    const layoutRaw = obj(p['layout'], `board.parts[${i}].layout`)
    const part: PartDefinition = {
      id: partId,
      designator: str(p['designator'], `board.parts[${i}].designator`),
      name: str(p['name'], `board.parts[${i}].name`),
      category: oneOf(p['category'], PART_CATEGORIES, `board.parts[${i}].category`),
      summary: str(p['summary'], `board.parts[${i}].summary`),
      buses: partBuses,
      pins,
      config,
      layout: {
        x: num(layoutRaw['x'], `board.parts[${i}].layout.x`),
        y: num(layoutRaw['y'], `board.parts[${i}].layout.y`),
        width: num(layoutRaw['width'], `board.parts[${i}].layout.width`),
        height: num(layoutRaw['height'], `board.parts[${i}].layout.height`)
      }
    }
    if (p['mpn'] !== undefined) part.mpn = str(p['mpn'], `board.parts[${i}].mpn`)
    if (p['deviceModel'] !== undefined) {
      part.deviceModel = str(p['deviceModel'], `board.parts[${i}].deviceModel`)
    }
    if (p['deviceOptions'] !== undefined) {
      part.deviceOptions = obj(p['deviceOptions'], `board.parts[${i}].deviceOptions`)
    }
    if (p['firmwareHook'] !== undefined) {
      const h = obj(p['firmwareHook'], `board.parts[${i}].firmwareHook`)
      const hook: FirmwareHook = {
        symbol: str(h['symbol'], `board.parts[${i}].firmwareHook.symbol`)
      }
      if (h['file'] !== undefined) hook.file = str(h['file'], `board.parts[${i}].firmwareHook.file`)
      if (h['line'] !== undefined) hook.line = num(h['line'], `board.parts[${i}].firmwareHook.line`)
      if (h['note'] !== undefined) hook.note = str(h['note'], `board.parts[${i}].firmwareHook.note`)
      part.firmwareHook = hook
    }
    return part
  })
  unique(
    parts.map((p) => p.id),
    'board.parts'
  )
  const mcuCount = parts.filter((p) => p.category === 'mcu').length
  if (mcuCount !== 1) fail('board.parts', `expected exactly one "mcu" part, found ${mcuCount}`)

  const partSignals = new Map(parts.map((p) => [p.id, new Set(p.pins.map((b) => b.signal))]))

  const nets: NetDefinition[] = arr(root['nets'], 'board.nets').map((raw, i) => {
    const n = obj(raw, `board.nets[${i}]`)
    const net: NetDefinition = {
      id: str(n['id'], `board.nets[${i}].id`),
      label: str(n['label'], `board.nets[${i}].label`),
      nodes: arr(n['nodes'], `board.nets[${i}].nodes`).map((node, j) => {
        const value = str(node, `board.nets[${i}].nodes[${j}]`)
        if (value.includes(':')) {
          const [partId, signal] = value.split(':')
          const signals = partSignals.get(partId ?? '')
          if (!signals) fail(`board.nets[${i}].nodes[${j}]`, `no part "${partId}"`)
          if (!signals.has(signal ?? '')) {
            fail(`board.nets[${i}].nodes[${j}]`, `part "${partId}" has no signal "${signal}"`)
          }
        } else if (!pinIds.has(value)) {
          fail(`board.nets[${i}].nodes[${j}]`, `"${value}" is neither a pin nor a part signal`)
        }
        return value
      })
    }
    if (n['bus'] !== undefined) {
      const busId = str(n['bus'], `board.nets[${i}].bus`)
      if (!busIds.has(busId)) fail(`board.nets[${i}].bus`, `"${busId}" is not a declared bus`)
      net.bus = busId
    }
    return net
  })
  unique(
    nets.map((n) => n.id),
    'board.nets'
  )

  const emulatorRaw = obj(root['emulator'], 'board.emulator')
  const emulator: EmulatorTarget = {}
  if (emulatorRaw['machine'] !== undefined) {
    emulator.machine = str(emulatorRaw['machine'], 'board.emulator.machine')
  }
  if (emulatorRaw['psramSize'] !== undefined) {
    emulator.psramSize = str(emulatorRaw['psramSize'], 'board.emulator.psramSize')
  }
  if (emulatorRaw['psramOctal'] !== undefined) {
    if (typeof emulatorRaw['psramOctal'] !== 'boolean') {
      fail('board.emulator.psramOctal', 'expected a boolean')
    }
    emulator.psramOctal = emulatorRaw['psramOctal']
  }
  if (emulatorRaw['flashSize'] !== undefined) {
    emulator.flashSize = str(emulatorRaw['flashSize'], 'board.emulator.flashSize')
  }
  if (emulatorRaw['network'] !== undefined) {
    const network = str(emulatorRaw['network'], 'board.emulator.network')
    if (network !== 'none' && network !== 'user') {
      fail('board.emulator.network', "expected 'none' or 'user'")
    }
    emulator.network = network
  }

  let firmware: FirmwareHint | undefined
  if (root['firmware'] !== undefined) {
    const f = obj(root['firmware'], 'board.firmware')
    firmware = {}
    if (f['env'] !== undefined) firmware.env = str(f['env'], 'board.firmware.env')
    if (f['envMatch'] !== undefined)
      firmware.envMatch = str(f['envMatch'], 'board.firmware.envMatch')
  }

  const canvasRaw = obj(root['canvas'], 'board.canvas')

  let pinExceptions: string[] | undefined
  if (root['pinExceptions'] !== undefined) {
    const pinIds = new Set(pins.map((p) => p.id))
    pinExceptions = arr(root['pinExceptions'], 'board.pinExceptions').map((v, i) => {
      const id = str(v, `board.pinExceptions[${i}]`)
      if (!pinIds.has(id)) fail(`board.pinExceptions[${i}]`, `no pin "${id}"`)
      return id
    })
  }

  return {
    schema: 1,
    id,
    name,
    mcu,
    vendor,
    pins,
    buses,
    parts,
    nets,
    emulator,
    ...(firmware ? { firmware } : {}),
    ...(pinExceptions ? { pinExceptions } : {}),
    canvas: {
      width: num(canvasRaw['width'], 'board.canvas.width'),
      height: num(canvasRaw['height'], 'board.canvas.height')
    }
  }
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
