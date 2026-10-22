/**
 * The device-model registry.
 *
 * ADR 0001 / the M4 roadmap: "Adding a device means adding a module and
 * referencing it — never editing a central switch statement." So there is no
 * switch here. A model file exports a {@link DeviceModelDescriptor}; the
 * built-in list in `builtin.ts` names the files; anything else registers
 * itself by calling {@link DeviceRegistry.register}. Resolution is by id.
 *
 * An id with no registered factory is a *visible no-op*, not a throw: the M9
 * definition references nine model ids and only one (`pinbench.led`) exists at
 * M4, so `create` returns `undefined` and the caller reports it once rather
 * than crashing the board load.
 */

import type { DeviceModel, DeviceModelDescriptor, DeviceModelFactory } from './model'

export class DeviceRegistry {
  private readonly factories = new Map<string, DeviceModelFactory>()
  private readonly summaries = new Map<string, string>()

  /** Register a model id. Throws only on a duplicate id — a real bug. */
  register(descriptor: DeviceModelDescriptor): void {
    if (this.factories.has(descriptor.id)) {
      throw new Error(`Device model "${descriptor.id}" is already registered`)
    }
    this.factories.set(descriptor.id, descriptor.create)
    this.summaries.set(descriptor.id, descriptor.summary)
  }

  /** Register many at once — used for the built-in list. */
  registerAll(descriptors: readonly DeviceModelDescriptor[]): void {
    for (const descriptor of descriptors) this.register(descriptor)
  }

  has(id: string): boolean {
    return this.factories.has(id)
  }

  /** Instantiate a model, or `undefined` when no factory is registered. */
  create(id: string, options?: Record<string, unknown>): DeviceModel | undefined {
    const factory = this.factories.get(id)
    return factory ? factory(options) : undefined
  }

  summaryOf(id: string): string | undefined {
    return this.summaries.get(id)
  }

  /** Registered ids, for diagnostics and the authoring docs. */
  ids(): string[] {
    return [...this.factories.keys()].sort()
  }
}

import { BUILT_IN_DEVICE_MODELS } from './builtin'

/**
 * The process-wide registry, pre-loaded with the built-ins. The main-process
 * device host uses this; tests that want isolation construct their own
 * `DeviceRegistry`.
 */
export const deviceRegistry = new DeviceRegistry()
deviceRegistry.registerAll(BUILT_IN_DEVICE_MODELS)
