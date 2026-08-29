/**
 * The device host: instantiates TypeScript device models for the parts on a
 * board, routes bus transactions and signal edges to them, and enforces the
 * failure policy ADR 0001 left open.
 *
 * It runs in the main process because a QEMU bus controller (C, in the fork,
 * from M6) reaches it over a Unix socket and the vCPU blocks on the reply.
 * The models themselves know nothing about sockets or Electron — see
 * `src/shared/devices/`.
 *
 * ## Failure policy (ADR 0001, open question 4)
 *
 * Models are synchronous by contract. The host cannot preempt a genuine
 * infinite loop in one — that would hang this process too. The real backstop
 * for a hung guest is the C-side socket read timeout the SPI controller gets
 * in M6; after it, the guest sees 0xFF and its controller raises a guest
 * diagnostic. What the host does on its side:
 *
 * - A model that **throws** is quarantined: its bus replies become all-`0xFF`
 *   (loud, never silent zeros — M7's rule, the radio) and a named `error` diagnostic is
 *   raised. It stays quarantined until the next `Reset`.
 * - A call that **runs long** (> `slowCallMs`, default 50) raises a one-shot
 *   `warn` naming the model, so a chatty or heavy model is visible before it
 *   becomes a mystery slowdown.
 * - A reply whose length does not match the request is padded/truncated to the
 *   request length and a diagnostic is raised.
 */

import { EventEmitter } from 'node:events'
import { createServer, type Server, type Socket } from 'node:net'
import { unlink } from 'node:fs/promises'
import type { BoardDefinition, PartDefinition } from '../shared/board'
import type { Diagnostic } from '../shared/diagnostics'
import type { DeviceContext, DeviceModel } from '../shared/devices/model'
import type {
  DeviceEventMessage,
  DeviceFramebufferMessage,
  DeviceSnapshotMessage
} from '../shared/devices/messages'
import { deviceRegistry, type DeviceRegistry } from '../shared/devices/registry'
import {
  BUS_NONE,
  encodeFrame,
  FrameDecoder,
  Op,
  SELECT_NONE,
  signalHash,
  type Frame,
  type FrameError
} from '../shared/devices/protocol'

export type { DeviceSnapshotMessage, DeviceEventMessage, DeviceFramebufferMessage }

/**
 * A framebuffer-bearing model (the ST7789 from M6). Duck-typed rather than
 * added to {@link DeviceModel} so a model only implements it when it has
 * pixels; the host pulls it on a refresh timer, never per transaction.
 */
interface FramebufferSource {
  takeFrame(): {
    width: number
    height: number
    madctl: number
    displayOn: boolean
    backlightOn: boolean
    inverted: boolean
    dirty: { x: number; y: number; w: number; h: number }
    pixels: Uint16Array
  } | null
}

function isFramebufferSource(model: DeviceModel): model is DeviceModel & FramebufferSource {
  return typeof (model as Partial<FramebufferSource>).takeFrame === 'function'
}

/** How often the host samples display models for a new frame. ~30 fps. */
const FRAME_INTERVAL_MS = 33

/**
 * Signal names that mean "this GPIO is this device's SPI chip-select". The M9's
 * parts don't agree on a name: the ST7789 and microSD call it `CS`, but the
 * LR1110 uses its datasheet name `NSS`. Without `NSS` here the radio has no
 * tracked select, defaults to always-addressable, and every ST7789 transaction
 * routes to two devices and gets dropped.
 */
const SPI_SELECT_SIGNALS = new Set(['CS', 'NSS', 'SS', 'CSB'])

interface LoadedDevice {
  part: PartDefinition
  model: DeviceModel
  /** signalHash → the part's signal name, for decoding `Signal` frames. */
  signalsByHash: Map<number, string>
  /** SoC pin number → the part's own signal name, for decoding `Gpio` frames. */
  signalsByPin: Map<number, string>
  /** The SoC pin carrying this part's SPI chip-select, if it has one. */
  csPin: number | null
  /** Whether this part's chip-select is currently asserted (low). */
  csLow: boolean
  /**
   * `model.outputSignals` resolved to SoC pin numbers — the lines this device
   * drives *into* the SoC (`BUSY`, `IRQ`, `PPS`). The host answers the guest's
   * `GPIO_IN` reads of these pins from {@link DeviceHost.pinLevels}.
   */
  outPinBySignal: Map<string, number>
  quarantined: boolean
  slowWarned: boolean
  lastSnapshotJson: string
  lastT: number
  /** Bytes this device has clocked on its bus since the last frame, for `busShare`. */
  frameBytes: number
}

export interface DeviceHostOptions {
  registry?: DeviceRegistry
  /** Wall-clock budget for one model call before a warning. */
  slowCallMs?: number
}

export class DeviceHost extends EventEmitter {
  private readonly registry: DeviceRegistry
  private readonly slowCallMs: number
  private devices = new Map<string, LoadedDevice>()
  /** board bus index → bus id. */
  private busOrder: string[] = []
  /** Signature of the currently loaded board, to make a repeat `load` a no-op. */
  private loadedSignature: string | null = null
  private server: Server | null = null
  private socketPath: string | null = null
  private connection: Socket | null = null
  /**
   * SoC input-pin number → the level a device model is currently driving onto
   * it (M7 host→guest line read). Answered on {@link Op.GpioRead}; the set of
   * keys is also the mask the {@link Op.Hello} reply hands the guest so it
   * knows which `GPIO_IN` reads to route here.
   */
  private pinLevels = new Map<number, 0 | 1>()
  /** board bus id → part ids on it, in board order. */
  private busMembers = new Map<string, string[]>()
  private frameTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: DeviceHostOptions = {}) {
    super()
    this.registry = options.registry ?? deviceRegistry
    this.slowCallMs = options.slowCallMs ?? 50
  }

  /**
   * Instantiate models for every part on `board` that names one. A model id
   * with no registered factory is reported once and the part left inert — the
   * M9 references nine ids and only `pinbench.led` exists at M4.
   */
  load(board: BoardDefinition): void {
    // A remount (React strict mode double-invokes effects in dev) must not tear
    // every model down, drop its state, and re-emit every "no model"
    // diagnostic. Only the parts of the board the host acts on matter.
    const signature = [
      board.id,
      board.buses.map((bus) => bus.id).join(','),
      board.parts.map((part) => `${part.id}:${part.deviceModel ?? ''}`).join(',')
    ].join('|')
    if (signature === this.loadedSignature) return
    this.loadedSignature = signature

    this.unloadModels()
    this.busOrder = board.buses.map((bus) => bus.id)
    this.busMembers = new Map()
    for (const part of board.parts) {
      for (const busId of part.buses) {
        const members = this.busMembers.get(busId) ?? []
        members.push(part.id)
        this.busMembers.set(busId, members)
      }
    }
    const spiBusIds = new Set(board.buses.filter((b) => b.kind === 'spi').map((b) => b.id))

    for (const part of board.parts) {
      const id = part.deviceModel
      if (!id) continue
      const model = this.registry.create(id, part.deviceOptions)
      if (!model) {
        this.diagnose(
          'info',
          `no-model-${part.id}`,
          `No device model "${id}" — ${part.designator} ${part.name} is inert`
        )
        continue
      }

      const signalsByHash = new Map<number, string>()
      const signalsByPin = new Map<number, string>()
      let csPin: number | null = null
      for (const binding of part.pins) {
        const hash = signalHash(binding.signal)
        const clash = signalsByHash.get(hash)
        if (clash && clash !== binding.signal) {
          this.diagnose(
            'warn',
            `sig-hash-${part.id}-${binding.signal}`,
            `${part.designator}: signals "${clash}" and "${binding.signal}" hash alike; edges may misroute`
          )
        }
        signalsByHash.set(hash, binding.signal)
        const pinNum = pinNumber(binding.pin)
        if (pinNum !== null) {
          signalsByPin.set(pinNum, binding.signal)
          if (SPI_SELECT_SIGNALS.has(binding.signal) && part.buses.some((b) => spiBusIds.has(b))) {
            csPin = pinNum
          }
        }
      }

      const outPinBySignal = new Map<string, number>()
      for (const signal of model.outputSignals ?? []) {
        const binding = part.pins.find((b) => b.signal === signal)
        const pinNum = binding ? pinNumber(binding.pin) : null
        if (pinNum !== null) {
          outPinBySignal.set(signal, pinNum)
          // Default the line to idle-low until the model drives it.
          if (!this.pinLevels.has(pinNum)) this.pinLevels.set(pinNum, 0)
        } else {
          this.diagnose(
            'warn',
            `outsig-${part.id}-${signal}`,
            `${part.designator}: model drives "${signal}" but the board binds no such pin`
          )
        }
      }

      const loaded: LoadedDevice = {
        part,
        model,
        signalsByHash,
        signalsByPin,
        csPin,
        // A chip-select idles high (deselected); the LR1110, which has no CS
        // GPIO of its own on this board, is treated as always addressable.
        csLow: csPin === null,
        outPinBySignal,
        quarantined: false,
        slowWarned: false,
        lastSnapshotJson: '',
        lastT: 0,
        frameBytes: 0
      }
      model.attach(this.contextFor(loaded))
      this.devices.set(part.id, loaded)
      this.pushSnapshot(loaded)
    }

    this.updateFrameTimer()
  }

  /**
   * Run the display-refresh timer only while a model with a framebuffer is
   * loaded. It samples {@link FramebufferSource.takeFrame} and emits a
   * `framebuffer` message per changed panel — off the per-transaction path,
   * so a 153,600-byte flush never touches {@link pushSnapshot}'s JSON dedupe.
   */
  private updateFrameTimer(): void {
    const wanted = [...this.devices.values()].some((d) => isFramebufferSource(d.model))
    if (wanted && !this.frameTimer) {
      this.frameTimer = setInterval(() => this.sampleFrames(), FRAME_INTERVAL_MS)
      if (typeof this.frameTimer.unref === 'function') this.frameTimer.unref()
    } else if (!wanted && this.frameTimer) {
      clearInterval(this.frameTimer)
      this.frameTimer = null
    }
  }

  private sampleFrames(): void {
    for (const device of this.devices.values()) {
      const model = device.model
      if (device.quarantined || !isFramebufferSource(model)) continue
      const frame = this.guard(device, 'takeFrame', () => model.takeFrame())
      if (!frame) continue
      const message: DeviceFramebufferMessage = {
        partId: device.part.id,
        deviceModel: device.model.id,
        width: frame.width,
        height: frame.height,
        madctl: frame.madctl,
        displayOn: frame.displayOn,
        backlightOn: frame.backlightOn,
        inverted: frame.inverted,
        dirty: frame.dirty,
        // `takeFrame` already hands back a standalone copy, exactly sized.
        pixels: frame.pixels.buffer as ArrayBuffer
      }
      this.emit('framebuffer', message)
    }
    // Close the per-frame byte window for the bus-share meter across every
    // device on every bus, not just panels.
    for (const device of this.devices.values()) device.frameBytes = 0
  }

  /** Registered model ids the loaded board actually uses. */
  activeModelIds(): string[] {
    return [...new Set([...this.devices.values()].map((d) => d.model.id))].sort()
  }

  // --- direct injection (tests, and a future non-QEMU dev mode) --------------

  /** Feed a whole bus transaction to the model on `partId`; returns MISO. */
  injectBus(
    partId: string,
    mosi: Uint8Array,
    opts: { select?: string | number; t?: number } = {}
  ): Uint8Array {
    const device = this.devices.get(partId)
    if (!device) throw new Error(`no device loaded for part "${partId}"`)
    const bus = device.part.buses[0] ?? 'unknown'
    const t = opts.t ?? (device.lastT += 1_000_000)
    return this.runBus(device, {
      bus,
      kind: 'spi',
      ...(opts.select === undefined ? {} : { select: opts.select }),
      mosi,
      t
    })
  }

  /** Drive a line into the model on `partId`. */
  injectSignal(partId: string, signal: string, level: 0 | 1, t?: number): void {
    const device = this.devices.get(partId)
    if (!device) throw new Error(`no device loaded for part "${partId}"`)
    const at = t ?? (device.lastT += 1_000_000)
    this.runSignal(device, signal, level, at)
  }

  /** Reset every loaded model and clear quarantine. */
  resetAll(): void {
    for (const device of this.devices.values()) {
      device.quarantined = false
      device.slowWarned = false
      this.guard(device, 'reset', () => device.model.reset())
      this.pushSnapshot(device)
    }
  }

  // --- socket transport (the QEMU bridge lands here from M6) -----------------

  async listen(socketPath: string): Promise<void> {
    await this.close()
    await unlink(socketPath).catch(() => undefined)
    this.socketPath = socketPath
    this.server = createServer((socket) => this.onConnection(socket))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(socketPath, () => {
        this.server!.off('error', reject)
        resolve()
      })
    })
  }

  private onConnection(socket: Socket): void {
    if (this.connection) {
      // One controller at a time. A second connection is a bug upstream.
      socket.destroy()
      return
    }
    this.connection = socket
    socket.setNoDelay(true)
    const decoder = new FrameDecoder()
    socket.on('data', (chunk: Buffer) => {
      let frames: Frame[]
      try {
        frames = decoder.push(new Uint8Array(chunk))
      } catch (error) {
        this.diagnose(
          'error',
          'frame-decode',
          `device stream desynced: ${(error as FrameError).message}`
        )
        socket.destroy()
        return
      }
      for (const frame of frames) {
        const reply = this.handleFrame(frame)
        if (reply) socket.write(reply)
      }
    })
    socket.on('close', () => {
      if (this.connection === socket) this.connection = null
    })
    socket.on('error', () => socket.destroy())
  }

  /**
   * Dispatch one decoded frame; return the encoded reply frame, or null for a
   * frame that takes no reply. Exposed for tests that skip the socket.
   */
  handleFrame(frame: Frame): Uint8Array | null {
    switch (frame.op) {
      case Op.Hello:
        // Reply payload = 8-byte little-endian mask of the SoC input pins the
        // host will answer GPIO_IN reads for (M7 host→guest line read).
        return encodeFrame({ ...frame, reply: true, payload: this.inputPinMask() })
      case Op.GpioRead: {
        const level = this.pinLevels.get(frame.select) ?? 0
        return encodeFrame({ ...frame, reply: true, payload: Uint8Array.of(level) })
      }
      case Op.Reset:
        this.resetAll()
        return null
      case Op.Signal: {
        const device = this.deviceOnBus(frame.bus, frame.select)
        if (device) {
          const name = device.signalsByHash.get(frame.select) ?? `sig#${frame.select}`
          this.runSignal(device, name, (frame.payload[0] ? 1 : 0) as 0 | 1, frame.t)
        }
        return null
      }
      case Op.Gpio: {
        this.handleGpio(frame.select, (frame.payload[0] ? 1 : 0) as 0 | 1, frame.t)
        return null
      }
      case Op.Xfer: {
        const device = this.deviceForXfer(frame.bus, frame.select)
        const bus = this.busOrder[frame.bus] ?? 'unknown'
        const miso = device
          ? this.runBus(device, {
              bus,
              kind: 'spi',
              ...(frame.select === SELECT_NONE ? {} : { select: frame.select }),
              mosi: frame.payload,
              t: frame.t
            })
          : loud(frame.payload.length)
        if (!device) {
          this.diagnose(
            'warn',
            `no-target-${frame.bus}-${frame.select}`,
            `bus transaction for bus ${frame.bus} select ${frame.select} hit no device`
          )
        }
        return encodeFrame({ ...frame, reply: true, payload: miso })
      }
      default: {
        const op = frame.op as number
        this.diagnose('error', `bad-op-${op}`, `unknown device frame op 0x${op.toString(16)}`)
        return null
      }
    }
  }

  async close(): Promise<void> {
    this.connection?.destroy()
    this.connection = null
    if (this.server) {
      const server = this.server
      this.server = null
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    if (this.socketPath) {
      await unlink(this.socketPath).catch(() => undefined)
      this.socketPath = null
    }
  }

  async dispose(): Promise<void> {
    this.unloadModels()
    this.loadedSignature = null
    if (this.frameTimer) {
      clearInterval(this.frameTimer)
      this.frameTimer = null
    }
    await this.close()
  }

  // --- internals -----------------------------------------------------------

  private contextFor(device: LoadedDevice): DeviceContext {
    return {
      driveSignal: (signal, level) => {
        // Host→guest line: record the level so a guest GPIO_IN read of the
        // bound pin (Op.GpioRead) sees it. The LR1110's BUSY/IRQ arrive here.
        const pin = device.outPinBySignal.get(signal)
        if (pin !== undefined) this.pinLevels.set(pin, level)
        this.emit('event', {
          partId: device.part.id,
          event: {
            t: device.lastT,
            kind: 'drive',
            summary: `${signal} → ${level}`,
            detail: { signal, level }
          }
        } satisfies DeviceEventMessage)
      },
      emit: (event) => {
        this.emit('event', {
          partId: device.part.id,
          event: { ...event, t: event.t ?? device.lastT }
        } satisfies DeviceEventMessage)
      },
      diagnose: (severity, message) => {
        this.diagnose(
          severity,
          `dev-${device.part.id}-${message.slice(0, 24)}`,
          `${device.part.designator}: ${message}`
        )
      }
    }
  }

  private runBus(
    device: LoadedDevice,
    txn: Parameters<NonNullable<DeviceModel['onBus']>>[0]
  ): Uint8Array {
    device.lastT = txn.t
    device.frameBytes += txn.mosi.length
    if (device.quarantined || !device.model.onBus) return loud(txn.mosi.length)
    const result = this.guard(device, 'onBus', () => device.model.onBus!(txn))
    if (!result) return loud(txn.mosi.length)
    let miso = result.miso
    if (miso.length !== txn.mosi.length) {
      this.diagnose(
        'warn',
        `len-${device.part.id}`,
        `${device.part.designator}: model returned ${miso.length} bytes for a ${txn.mosi.length}-byte transaction`
      )
      const fixed = loud(txn.mosi.length)
      fixed.set(miso.subarray(0, txn.mosi.length))
      miso = fixed
    }
    this.pushSnapshot(device)
    return miso
  }

  private runSignal(device: LoadedDevice, signal: string, level: 0 | 1, t: number): void {
    device.lastT = t
    if (device.quarantined || !device.model.onSignal) return
    this.guard(device, 'onSignal', () => device.model.onSignal!({ signal, level, t }))
    this.pushSnapshot(device)
  }

  /** Run a model call under the throw / slow-call policy. Returns undefined on throw. */
  private guard<T>(device: LoadedDevice, op: string, call: () => T): T | undefined {
    const started = performance.now()
    try {
      const value = call()
      const elapsed = performance.now() - started
      if (elapsed > this.slowCallMs && !device.slowWarned) {
        device.slowWarned = true
        this.diagnose(
          'warn',
          `slow-${device.part.id}`,
          `${device.part.designator}: ${device.model.id}.${op} took ${elapsed.toFixed(0)} ms — models must be fast and non-blocking`
        )
      }
      return value
    } catch (error) {
      device.quarantined = true
      this.diagnose(
        'error',
        `throw-${device.part.id}`,
        `${device.part.designator}: ${device.model.id}.${op} threw — device quarantined until reset: ${(error as Error).message}`
      )
      this.pushSnapshot(device)
      return undefined
    }
  }

  /** 8-byte LE bitmask of the SoC input pins the host answers GPIO_IN for. */
  private inputPinMask(): Uint8Array {
    const out = new Uint8Array(8)
    for (const pin of this.pinLevels.keys()) {
      if (pin >= 0 && pin < 64) out[pin >> 3]! |= 1 << (pin & 7)
    }
    return out
  }

  private deviceOnBus(busIndex: number, select: number): LoadedDevice | undefined {
    if (busIndex === BUS_NONE) return undefined
    const busId = this.busOrder[busIndex]
    if (!busId) return undefined
    const onBus = [...this.devices.values()].filter((d) => d.part.buses.includes(busId))
    if (onBus.length <= 1) return onBus[0]
    return onBus.find((d) => d.signalsByHash.has(select)) ?? undefined
  }

  /**
   * Route one SPI transaction. The M9's SPI parts are addressed by GPIO
   * chip-selects the firmware toggles itself (see {@link Op.Gpio}), so with no
   * hardware select in the frame the target is whichever device on the bus has
   * its `CS` currently low. Exactly one should — {@link handleGpio} raises a
   * bus-contention diagnostic when two are, which is a real hardware fault the
   * roadmap calls out as a class of bug PinBench can catch.
   */
  private deviceForXfer(busIndex: number, select: number): LoadedDevice | undefined {
    if (busIndex === BUS_NONE) return undefined
    const busId = this.busOrder[busIndex]
    if (!busId) return undefined
    const onBus = [...this.devices.values()].filter((d) => d.part.buses.includes(busId))
    if (onBus.length <= 1) return onBus[0]
    if (select !== SELECT_NONE) {
      const byHash = onBus.find((d) => d.signalsByHash.has(select))
      if (byHash) return byHash
    }
    const selected = onBus.filter((d) => d.csLow)
    return selected.length === 1 ? selected[0] : undefined
  }

  /**
   * A guest GPIO write. Fan it out to every device model that binds the pin,
   * update chip-select tracking, and flag two-selects-low bus contention.
   */
  private handleGpio(pin: number, level: 0 | 1, t: number): void {
    for (const device of this.devices.values()) {
      const signal = device.signalsByPin.get(pin)
      if (!signal) continue
      if (device.csPin === pin) device.csLow = level === 0
      this.runSignal(device, signal, level, t)
    }
    this.checkBusContention(t)
  }

  private checkBusContention(t: number): void {
    for (const [busId, partIds] of this.busMembers) {
      const low = partIds
        .map((id) => this.devices.get(id))
        .filter((d): d is LoadedDevice => !!d && d.csPin !== null && d.csLow)
      const key = `cs-contention-${busId}`
      if (low.length >= 2) {
        const names = low.map((d) => `${d.part.designator} ${signalCsLabel(d)}`).join(' + ')
        this.diagnose(
          'warn',
          key,
          `${busId}: ${names} chip-selects asserted together at ${(t / 1e6).toFixed(1)} ms — a bus fault; the last writer wins and reads collide`
        )
      }
    }
  }

  private pushSnapshot(device: LoadedDevice): void {
    const state = device.model.snapshot()
    const meters = device.model.meters.map((m) => ({
      id: m.id,
      label: m.label,
      ...(m.unit === undefined ? {} : { unit: m.unit }),
      value: m.id === 'busShare' ? this.busShareOf(device) : safeMeter(device.model, m.id)
    }))
    const message: DeviceSnapshotMessage = {
      partId: device.part.id,
      deviceModel: device.model.id,
      designator: device.part.designator,
      name: device.part.name,
      state,
      meters,
      quarantined: device.quarantined
    }
    const json = JSON.stringify(message)
    if (json === device.lastSnapshotJson) return
    device.lastSnapshotJson = json
    this.emit('snapshot', message)
  }

  private diagnose(severity: Diagnostic['severity'], id: string, message: string): void {
    this.emit('diagnostic', { id: `device-${id}`, severity, message } satisfies Diagnostic)
  }

  /**
   * This device's share of the traffic on its bus this frame, as a whole
   * percentage. The model cannot compute it — it only sees its own bytes — so
   * the host, which routes for the whole bus, fills the `busShare` meter here.
   */
  private busShareOf(device: LoadedDevice): number | undefined {
    const busId = device.part.buses[0]
    if (!busId) return undefined
    const peers = (this.busMembers.get(busId) ?? [])
      .map((id) => this.devices.get(id))
      .filter((d): d is LoadedDevice => !!d)
    const total = peers.reduce((sum, d) => sum + d.frameBytes, 0)
    if (total <= 0) return 0
    return Math.round((device.frameBytes / total) * 100)
  }

  private unloadModels(): void {
    for (const device of this.devices.values()) {
      try {
        device.model.detach()
      } catch {
        // A model that throws on detach is already on its way out; nothing to do.
      }
    }
    this.devices = new Map()
    this.pinLevels = new Map()
  }
}

/** A reply that is impossible to mistake for real data — never silent zeros. */
function loud(length: number): Uint8Array {
  return new Uint8Array(length).fill(0xff)
}

/** `"GPIO16"` → `16`; anything without a trailing number → `null`. */
function pinNumber(pinId: string): number | null {
  const m = /(\d+)$/.exec(pinId)
  return m ? Number(m[1]) : null
}

/** The board net label for a device's chip-select, for a contention message. */
function signalCsLabel(device: LoadedDevice): string {
  const binding = device.part.pins.find((b) => SPI_SELECT_SIGNALS.has(b.signal))
  return binding ? `${binding.signal} ${binding.pin}` : 'CS'
}

function safeMeter(model: DeviceModel, id: string): number | undefined {
  try {
    return model.meter(id)
  } catch {
    return undefined
  }
}
