/**
 * The device models PinBench ships with.
 *
 * Adding a device is: write `src/shared/devices/<name>.ts` exporting a
 * `DeviceModelDescriptor`, then add one line here. No switch statement, no
 * registration order that matters. `docs/devices/authoring.md` walks through
 * it.
 *
 * At M4 there is exactly one — the LED that proves the interface. M6 adds the
 * ST7789, M8 the LR1110, and so on; each is one import and one array entry.
 */

import type { DeviceModelDescriptor } from './model'
import { ledDescriptor } from './led'

export const BUILT_IN_DEVICE_MODELS: readonly DeviceModelDescriptor[] = [ledDescriptor]
