# Authoring a device model

A device model is a TypeScript module that emulates one part on a board — a
radio, a display, a sensor, an LED. This guide is how you write one.

Written at M4, while the API is small enough to describe honestly. If something
here has drifted from the code, the code
(`src/shared/devices/model.ts`) wins — please fix the doc.

## Why TypeScript, and what that costs you

[ADR 0001](../adr/0001-device-model-boundary.md) measured the emulation bridge
and decided device models are TypeScript modules hosted in the PinBench
process, not C inside the QEMU fork. The consequences you inherit:

- **You never touch QEMU.** No build environment, no recompile loop. A model is
  a normal TypeScript file with a normal test.
- **Your handler is transaction-shaped, never byte-shaped.** You are handed a
  whole bus transaction — every byte clocked between one chip-select assertion
  and its release — and you return the whole reply. A per-byte interface would
  make an ST7789 frame flush take 7.7 seconds. Budget your work by
  _transaction count_, not byte count.
- **You run on the guest's thread, in effect.** A bus controller in QEMU blocks
  the emulated CPU until your handler returns. Keep handlers fast and
  non-blocking — no `await`, no sync file I/O, no busy loops. A model that
  throws is quarantined (its replies become `0xFF` and a diagnostic is raised)
  until the board resets; a model that runs longer than 50 ms earns a warning.

## The interface

```ts
import type {
  DeviceModel,
  DeviceContext,
  BusTransaction,
  BusResponse,
  SignalEdge,
  MeterDeclaration,
  DeviceSnapshot
} from '@shared/devices/model'
```

A model implements `DeviceModel`. Only the hooks your part actually has:

| Member                 | When                                                                     |
| ---------------------- | ------------------------------------------------------------------------ |
| `id`                   | Always. Matches `PartDefinition.deviceModel`, e.g. `pinbench.led`.       |
| `meters`               | Always. The OUT-panel meter rows you publish. Fixed for the instance.    |
| `attach(ctx)`          | Always. Called once on board load; keep `ctx`.                           |
| `reset()`              | Always. Return to power-on state.                                        |
| `detach()`             | Always. Release timers and handles.                                      |
| `onBus(txn)`           | Only if the part sits on a bus. Whole transaction in, whole reply out.   |
| `onSignal(edge)`       | Only if a digital line runs into the part (its GPIO, a reset, a strobe). |
| `onCommand(cmd, args)` | Only if the part has an IN panel (wired from M7/M8).                     |
| `snapshot()`           | Always. Structured-clonable state for the renderer.                      |
| `meter(id)`            | Always. Current value of one declared meter.                             |

The `ctx` handed to `attach` lets you call back out:

- `ctx.driveSignal(signal, level)` — drive one of _your_ output lines (an IRQ,
  a BUSY line, a 1PPS strobe).
- `ctx.emit(event)` — append a row to your OUT-panel event log.
- `ctx.diagnose(severity, message)` — raise a diagnostic. **Do this for every
  command or register you have not implemented.** M7's hard-won rule (the radio): an
  unimplemented command that silently returns zeros costs days; one that raises
  a loud, named diagnostic costs minutes.

### Transaction shape

`BusTransaction` carries `bus` (the board bus id), `kind` (`spi` / `i2c` / …),
`select` (the asserted chip-select name for SPI, the address for I2C), `mosi`
(the bytes the guest sent) and `t` (nanoseconds since emulator start). Your
`BusResponse.miso` **must be the same length as `mosi`** — the host pads or
truncates and complains if it is not.

Most real devices are _command-then-payload_: the first byte or two of `mosi`
is a command, the rest is data, and the reply is either status bytes or the
data you were asked to read. You do not need per-byte semantics inside a
transaction. If you genuinely do — the reply to byte _n_ depends on byte _n−1_
mid-burst — that device is a candidate for C; talk about it first.

## The registry — how your model gets loaded

There is no central switch statement. Adding a device is:

1. Write `src/shared/devices/<name>.ts`. Export a `DeviceModelDescriptor`:

   ```ts
   export const fooDescriptor: DeviceModelDescriptor = {
     id: 'vendor.foo',
     summary: 'One line for the docs and the Library.',
     create: () => new FooModel()
   }
   ```

2. Add one line to `src/shared/devices/builtin.ts`:

   ```ts
   import { fooDescriptor } from './foo'
   export const BUILT_IN_DEVICE_MODELS = [ledDescriptor, fooDescriptor]
   ```

A board definition references your model by `id` in a part's `deviceModel`
field. An `id` with no registered model is a **visible no-op** — the host
reports it once and leaves the part inert — so a board can reference models
that do not exist yet.

## The test harness — write the test first

`src/shared/devices/harness.ts` drives a model with scripted transactions and
edges, with no QEMU and no Electron. This is the path of least resistance and
it is meant to be:

```ts
import { harness } from '@shared/devices/harness'
import { FooModel } from './foo'

it('acknowledges a soft reset', () => {
  const foo = harness(new FooModel())
  const miso = foo.bus({ bus: 'spi0', kind: 'spi', select: 'CS', mosi: Uint8Array.of(0x01, 0x00) })
  expect([...miso]).toEqual([0x00, 0xa5])
  expect(foo.snapshot()).toMatchObject({ mode: 'idle' })
})
```

The harness records `foo.events`, `foo.diagnostics` and `foo.driven` (lines
your model asserted), advances a virtual clock between un-timestamped actions,
and offers `foo.signal(...)`, `foo.pulse(...)`, `foo.command(...)`,
`foo.reset()` and `foo.meters()`. See `led.test.ts` for a worked example.

## Sketching the API against the hard devices

The M4 milestone's "watch for" is: do not design the interface around the LED.
Here is the LR1110 (M7) and the ST7789 (M6) drawn against this interface, which
is how we know the transaction shape and the meter model hold up.

### LR1110 radio — `semtech.lr1110`, on SPI

- **Buses / signals.** `onBus` on `spi0`, `select: 'NSS'`. `onSignal` for
  `NRESET`. `ctx.driveSignal('BUSY', …)` around every command, and
  `ctx.driveSignal('IRQ', 1)` on TX-done / RX-done / timeout.
- **`onBus`.** First byte(s) of `mosi` are the opcode (`SetRfFrequency`,
  `SetPacketType`, `WriteBuffer`, `GetStatus`, `ClearIrq`, …); the rest are
  parameters. The reply is status bytes, or buffer contents for a read opcode.
  Command-then-payload — no per-byte coupling. Every opcode the firmware issues
  that we have not modelled calls `ctx.diagnose('warn', 'unimplemented opcode
0x…')` and returns a benign status, never zeros.
- **State machine.** STDBY → FS → TX / RX, tracked in `snapshot()` so the OUT
  panel can show the current mode and last packet.
- **Meters.** `frequency` (Hz), `lastRssi` (dBm), `airtimeUsed` (%). Airtime is
  computed from the active BW/SF/CR the firmware programmed — the meter and any
  injected traffic stay consistent with LoRa reality.
- **IN panel (M7).** `onCommand('inject', { kind: 'advert', addr, hops, rssi,
snr })` drops a frame into the RX buffer and asserts `IRQ`.
- **What it stresses in the API that the LED does not:** a large `onBus`
  command surface; output lines with real timing (`BUSY`); a meter derived from
  earlier transactions rather than from the current one.

### ST7789 display — `sitronix.st7789`, on SPI

- **Buses / signals.** `onBus` on `spi0`, `select: 'CS'`. `onSignal` for `DC`
  (command vs data — **the level of `DC` when the transaction starts changes
  how `mosi` is parsed**), `RST`, and `BL` (backlight, reflected in the
  snapshot).
- **`onBus`.** A command byte (`CASET`, `RASET`, `RAMWR`, `MADCTL`, …) then
  parameters; `RAMWR` is followed by a large pixel payload — potentially the
  full 153,600 bytes. This is the transaction the whole batched design exists
  for: one `onBus` call, one framebuffer write, ~0.6 ms. If it is slow, count
  transactions per frame before blaming TypeScript (ADR 0001, §"Bad").
- **Snapshot.** The model owns the framebuffer; `snapshot()` returns it (or a
  dirty-rect delta) for the OUT panel to blit. Throttled to display refresh by
  the host, not emitted per transaction.
- **Meters.** `flushMs` (last full frame), `dirtyRects`, `busSharePct`.
- **What it stresses that the LED does not:** a transaction whose _meaning_
  depends on a separate signal line (`DC`); a snapshot that is bulk pixel data,
  not a handful of scalars; the single hottest path in the product.

Neither device needs a concept this interface lacks. That is the check M4
exists to run.
