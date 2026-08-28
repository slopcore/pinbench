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
 *   (loud, never silent zeros — M8's rule) and a named `error` diagnostic is
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
import type { DeviceEventMessage, DeviceSnapshotMessage } from '../shared/devices/messages'
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

export type { DeviceSnapshotMessage, DeviceEventMessage }

interface LoadedDevice {
  part: PartDefinition
  model: DeviceModel
  /** signalHash → the part's signal name, for decoding `Signal` frames. */
  signalsByHash: Map<number, string>
  quarantined: boolean
  slowWarned: boolean
  lastSnapshotJson: string
  lastT: number
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

    for (const part of board.parts) {
      const id = part.deviceModel
      if (!id) continue
      const model = this.registry.create(id)
      if (!model) {
        this.diagnose(
          'info',
          `no-model-${part.id}`,
          `No device model "${id}" — ${part.designator} ${part.name} is inert`
        )
        continue
      }

      const signalsByHash = new Map<number, string>()
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
      }

      const loaded: LoadedDevice = {
        part,
        model,
        signalsByHash,
        quarantined: false,
        slowWarned: false,
        lastSnapshotJson: '',
        lastT: 0
      }
      model.attach(this.contextFor(loaded))
      this.devices.set(part.id, loaded)
      this.pushSnapshot(loaded)
    }
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
        return encodeFrame({ ...frame, reply: true })
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
      case Op.Xfer: {
        const device = this.deviceOnBus(frame.bus, frame.select)
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
    await this.close()
  }

  // --- internals -----------------------------------------------------------

  private contextFor(device: LoadedDevice): DeviceContext {
    return {
      driveSignal: (signal, level) => {
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

  private deviceOnBus(busIndex: number, select: number): LoadedDevice | undefined {
    if (busIndex === BUS_NONE) return undefined
    const busId = this.busOrder[busIndex]
    if (!busId) return undefined
    const onBus = [...this.devices.values()].filter((d) => d.part.buses.includes(busId))
    if (onBus.length <= 1) return onBus[0]
    // More than one device shares this bus (SPI0 on the M9). Disambiguate by
    // the selected signal's hash matching one of the part's own signals. M6
    // makes this exact once the SPI controller tracks chip-select indices.
    return onBus.find((d) => d.signalsByHash.has(select)) ?? undefined
  }

  private pushSnapshot(device: LoadedDevice): void {
    const state = device.model.snapshot()
    const meters = device.model.meters.map((m) => ({
      id: m.id,
      label: m.label,
      ...(m.unit === undefined ? {} : { unit: m.unit }),
      value: safeMeter(device.model, m.id)
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

  private unloadModels(): void {
    for (const device of this.devices.values()) {
      try {
        device.model.detach()
      } catch {
        // A model that throws on detach is already on its way out; nothing to do.
      }
    }
    this.devices = new Map()
  }
}

/** A reply that is impossible to mistake for real data — never silent zeros. */
function loud(length: number): Uint8Array {
  return new Uint8Array(length).fill(0xff)
}

function safeMeter(model: DeviceModel, id: string): number | undefined {
  try {
    return model.meter(id)
  } catch {
    return undefined
  }
}
