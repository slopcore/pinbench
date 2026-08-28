# ADR 0001 — Where device models live

- **Status.** Accepted
- **Date.** 2026-08-28
- **Milestone.** M0 (the spike that produced these numbers)
- **Supersedes.** Nothing. This is the first architectural decision PinBench makes.

## Context

PinBench emulates a board — an ESP32-S3 plus the parts wired to it — and every
part needs a model: an LR1110 radio, an ST7789 display, a microSD card, a GNSS
receiver, an RTC, an IMU, a magnetometer, a keyboard coprocessor, and whatever
a user drags onto the canvas next. Those models can live in one of two places:

- **Native C, inside the espressif/qemu fork.** Best fidelity, direct access to
  QEMU's bus machinery, and no transport at all. Also: contributors need a QEMU
  build environment, every model change is a recompile, and models are not
  testable without booting an emulator.
- **TypeScript, in the Electron process, behind a socket.** Hot-reloadable,
  unit-testable with no QEMU in the loop, and writing one is a normal
  afternoon's work for anyone who can write TypeScript. Viable only if the
  transport is fast enough.

The roadmap deliberately refused to guess between them (locked decision 5:
"decided by spike"). This ADR records what the spike measured and what follows
from it.

The number that decides it is the ST7789's full-frame flush: **320 × 240 × 16bpp
= 153,600 bytes**, which M6's firmware will push repeatedly.

## What was built

Throwaway code, all of it under `spike/`:

- `spike/qemu/hw/ssi/pinbench_bridge.c` — an SSI peripheral that forwards every
  transaction over a Unix domain socket to a Node process and blocks for the
  reply. Supports a per-byte op and a whole-buffer burst op.
- `spike/qemu/hw/misc/pinbench_bench.c` — a native C device model implementing
  the same byte sink, plus a memory-mapped stopwatch at `0x60041000` that runs
  a chosen mode N times and reports elapsed nanoseconds and a checksum.
- `spike/bridge-server/server.mjs` — the Node-hosted model. Implements the same
  sink in JavaScript.
- `spike/firmware/bench/` — Arduino firmware that drives the harness and prints
  CSV on UART0. Real firmware, real MMIO, real vCPU blocking: the numbers
  include every cost a device model imposes on the guest.

The C and JS models compute the same checksum. **Every mode in the tables below
reports an identical checksum for identical input**, which is what makes the
comparison meaningful — if the two implementations drifted, the numbers would be
measuring different work.

## Environment

Recording this precisely because the conclusion is a latency measurement and
latency measurements do not travel.

| | |
|---|---|
| QEMU | `espressif/qemu` tag `esp-develop-9.2.2-20260417` (`40edcca`), QEMU 9.2.2 |
| Configure | `--target-list=xtensa-softmmu --disable-docs --disable-sdl --disable-gtk --disable-vnc --disable-werror --disable-capstone --disable-tools --enable-slirp --enable-debug-info` |
| Machine | `-machine esp32s3` |
| Host | Linux 6.18 x86_64, Intel Xeon @ 2.10 GHz, 4 vCPU, 15 GB RAM |
| Node | v22.22.2 |
| Toolchain | gcc 13.3.0; PlatformIO 6.1.19, `platformio/espressif32@6.11.0` |

**This is not macOS.** The roadmap targets macOS first (locked decision 7) and
this spike ran on the Linux host that was available. Unix-socket round-trip
latency is the load-bearing number and it is OS- and scheduler-dependent, so
§"Open questions" carries an action to re-measure on macOS before M6 commits
the display to a boundary.

## Measurements

Two runs, `spike/results/bench-linux-run{1,2}.csv`. The tables below are run 1;
run 2 agrees within a few percent on everything measured over a full frame
(`bridge-burst` 4.0 vs 4.5 ns/byte, `ssi-native` 25.5 vs 25.2, `native-direct`
1.4 vs 1.3). The single-byte round trip is the noisiest figure — 48 µs in run 1,
64 µs in run 2 — because at that size the measurement is almost entirely
scheduler latency. Treat it as *tens of microseconds* and do not build a budget
on the second decimal place.
`ms/frame` is the per-byte cost projected onto one 153,600-byte flush.

### Per-byte cost, measured over a full 153,600-byte frame (×5)

| Mode | ns/byte | MiB/s | ms per frame | Frames/s ceiling |
|---|---|---|---|---|
| `native-burst` — C model, whole buffer, one call | **0.1** | 14,925 | **0.01** | ~100,000 |
| `native-direct` — C model, one call per byte | **1.4** | 691 | **0.21** | ~4,700 |
| `bridge-burst` — Node model, whole buffer, one round trip | **4.0** | 236 | **0.62** | ~1,600 |
| `ssi-native` — C model reached through `ssi_transfer()` | **25.5** | 37 | **3.91** | ~256 |
| `ssi-bridge` — Node model through `ssi_transfer()`, per byte | **48,336** | 0.02 | **7,424** | ~0.13 |
| `bridge-byte` — Node model, round trip per byte | **50,206** | 0.02 | **7,712** | ~0.13 |

### Single-transaction round trip (1 byte × 2000)

| Mode | ns per transaction |
|---|---|
| `native-direct` | 2.3 |
| `ssi-native` | 34.4 |
| `bridge-byte` | 48,137 |

A socket round trip from inside the vCPU thread costs **tens of microseconds**
— 48 µs here, 64 µs in the replicate run. That is two context switches and a
trip through Node's event loop, and it is four orders of magnitude more than a
C function call.

### Burst-size sweep, bridged only (64 KiB of traffic at every point)

| Burst size | `bridge-byte` ns/byte | `bridge-burst` ns/byte |
|---|---|---|
| 16 B | 45,370 | 3,047 |
| 64 B | 47,420 | 741 |
| 256 B | 49,426 | 183 |
| 1 KiB | 47,006 | 45.8 |
| 4 KiB | 48,301 | 16.6 |
| 16 KiB | 47,575 | 10.7 |
| 64 KiB | 46,126 | 4.4 |
| 150 KiB (full frame) | 50,206 | 4.0 |

Per-byte bridging is flat at ~48 µs regardless of transfer size, because the
size never enters into it: it is one round trip per byte, always. Batching is
pure amortisation, and it crosses below native-per-byte-over-SSI (25.5 ns)
somewhere between **1 KiB and 4 KiB**.

## Decision

**Device models are TypeScript modules hosted in the PinBench process, reached
over a batching socket protocol. Native C in the QEMU fork is reserved for bus
controllers and the batching layer they need.**

The conventional expectation — hot devices in C, cold devices in TypeScript —
is not what the numbers say. The axis that matters is not *C versus
TypeScript*, it is *per-byte versus batched*:

- A **TypeScript** display model fed whole frames runs at **0.62 ms/frame**.
- A **native C** display model fed one byte at a time through QEMU's
  `ssi_transfer()` runs at **3.91 ms/frame** — six times slower.

Moving the display into C to make it fast, while leaving it on a per-byte bus
API, would have been a large amount of work in the wrong direction. Batching
buys ~12,000×; rewriting in C buys ~6×, and only once batching is already
there.

So the boundary is drawn at the bus, not at the device:

1. **Bus controllers are C, in the fork.** SPI2/SPI3, I²C, and UART controllers
   are register-level models in QEMU. They are shared infrastructure, they are
   few, and they change rarely.
2. **Controllers hand devices buffers, not bytes.** Each controller accumulates
   a transaction and issues **one** bridge call per transaction. QEMU's stock
   `ssi_transfer()` is per-byte by construction, so PinBench adds a bulk hook
   alongside it rather than using it on hot paths. This is the single most
   important consequence of this ADR.
3. **Device models are TypeScript**, including the ST7789. They implement a
   transaction interface, are unit-testable without QEMU, and are what a
   contributor writes.
4. **Escape hatch.** A device that turns out to need per-byte semantics inside a
   transaction — one whose reply to byte *n* depends on byte *n−1* mid-burst —
   can be implemented in C. None of the M9's parts are expected to need this:
   SPI displays, flash, SD and the LR1110 are all command-then-payload. Judge
   this per device against measurements, not in advance.

## Consequences

**Good.**

- Adding a device is writing a TypeScript module. No QEMU build environment, no
  recompile, and the M4 test harness can drive models directly.
- The 0.62 ms/frame figure leaves the display budget nearly untouched: a 60 fps
  UI spends under 4% of its frame time in the bridge.
- The C surface stays small and stable — a handful of controllers — so rebasing
  onto a newer `espressif/qemu` stays cheap.

**Bad, or at least costly.**

- The bulk hook is new QEMU code with no upstream equivalent, and it is on the
  critical path for M6. It must exist before the ST7789 model is useful.
- Every device model now has a synchronous socket round trip in its path. At
  roughly 50 µs each, a device that issues many small transactions per frame
  will hurt: **10 transactions per frame is ~0.5 ms, 100 is ~5 ms.** Transaction
  *count* is the budget to watch, not byte count.
- A model that blocks blocks the vCPU. A slow or crashed TypeScript model
  freezes the guest rather than glitching it. The device host needs a timeout
  and a defined failure mode — surface it in the UI, don't hang.

**Neutral.**

- Nothing here rules out moving an individual device to C later; the interface
  is the same either way.

## What else the spike found

Recorded here because these are the facts that shape M2, M6 and M8, and they
were expensive to learn.

**MeshCore boots the SoC and stalls in peripheral bring-up.** A
`Heltec_Wireless_Paper_repeater` build (MeshCore `simple_repeater`) runs the ROM
bootloader, the second-stage bootloader, and reaches `setup()`, then blocks
before its first serial output. Sampling the guest PC across five separate runs
put it in `esp_pm_impl_waiti` every time — the idle task — so the setup task is
*blocked*, not spinning: it is waiting on a peripheral that will never answer.
Everything before its first `Serial.print` is `board.begin()`,
`display.begin()` (e-ink, waits on a BUSY line) and `radio_init()` (SX1262 over
SPI). **The fork models SPI1 only** — the flash/PSRAM controller. SPI2 and SPI3,
where every board peripheral actually lives, do not exist; writes to their
registers land in the catch-all IO region and read back as zero. This is not a
blocker, it is the work: SPI2/SPI3 controllers are prerequisites for M6 and M8
and should be scheduled as such.

**Flash mode matters, and the failure is misleading.** Built with the board
default (QIO), MeshCore boot-loops with `assert failed: … startup.c:290` —
`esp_vfs_console_register()` — because QEMU's `m25p80` flash model does not
implement the QPI commands the QIO bootloader issues (`Unknown cmd 5a`,
`Unknown cmd 77` in the QEMU log). Building with `board_build.flash_mode = dio`
and `board_build.arduino.memory_type = dio_qspi` fixes it completely. PinBench
must set DIO when it builds for the emulator (M3) and say why, or every user's
first boot will be a crash loop with an error message pointing at the console
driver.

**PSRAM is fine — better than the roadmap feared.** The roadmap flagged limited
PSRAM emulation against the M9's 8 MB as a possible blocker. It is not:

- `-machine esp32s3 -m 8M` gives a working 8 MB PSRAM. Firmware reports
  `psram_size=8386279`, and a 4 MB allocation plus write/read-back verifies.
- The default is **quad** PSRAM. The M9's ESP32-S3-R8 is **octal**, and an OPI
  build fails with `PSRAM ID read error: 0x00000000`. Adding
  `-global ssi_psram.is_octal=true` makes the identical OPI build work
  perfectly. PinBench's launcher must set this per board.
- `default_ram_size` is 0, so **no `-m` means no PSRAM at all**, silently.

**Arduino-on-ESP32-S3 works out of the box.** A PlatformIO
`espressif32@6.11.0` + Arduino `hello_world` boots and prints on UART0 with no
QEMU changes. The roadmap's step 2 called for an ESP-IDF image; Arduino was used
instead because it is the framework MeshCore actually builds against, which
makes it the more useful thing to have proven.

**Build dependencies not in the roadmap.** The fork needs `libgcrypt` and
`libslirp` headers; `--disable-slirp` does *not* stop `net/slirp.c` from being
built, so the dependency is effectively mandatory. Worth pinning in the M3
toolchain bootstrap.

## Open questions

Each is owned by a milestone rather than left floating.

1. **Re-measure on macOS before M6 commits.** Every latency number here is from
   Linux. If Darwin's Unix-socket round trip is materially worse than ~50 µs, the
   *batching* conclusion still holds — batching amortises whatever the round
   trip costs — but the per-transaction budget in §Consequences must be rewritten.
   Re-run `spike/run-bench.sh` on macOS and amend this ADR with a second table.
2. **Design the bulk hook in M4, not M6.** The `DeviceModel` interface must be
   transaction-shaped from the first line of code. Retrofitting batching onto a
   per-byte interface is the mistake this ADR exists to prevent.
3. **Framing overhead is not measured.** The spike moved raw bytes with a 5-byte
   header. Real traffic carries a device id, a bus id, and probably a timestamp.
   Measure it in M4 once the real protocol exists; the burst numbers are a floor,
   not a promise.
4. **Blocking-model failure policy is undecided.** M4 should choose the timeout
   and what the guest sees when a model exceeds it.

## Reproducing

```sh
git clone --depth 1 --branch esp-develop-9.2.2-20260417 \
  https://github.com/espressif/qemu.git
spike/qemu/apply.sh ./qemu
(cd qemu && mkdir -p build && cd build && ../configure --target-list=xtensa-softmmu \
   --disable-docs --disable-sdl --disable-gtk --disable-vnc --disable-werror \
   --disable-capstone --disable-tools --enable-slirp --enable-debug-info && ninja)

pio run -d spike/firmware/bench
spike/bin/mkflash.sh spike/firmware/bench/.pio/build/esp32s3 bench-flash.bin
spike/run-bench.sh ./qemu/build bench-flash.bin
```

`spike/README.md` has the details, including the `mkflash.sh` helper and the
`PINBENCH_BRIDGE_SOCKET` environment variable that arms the harness.

---

## Amendment — M4 (2026-08-28): the real protocol, and a first macOS number

M4 built the device-model interface, registry and test harness, and the real
wire protocol between a QEMU bus controller and the Node host
(`src/shared/devices/protocol.ts`). Two of this ADR's open questions can now be
answered with measurements from `scripts/bench-framing.mjs`.

**Open question 3 — framing overhead — resolved.** The spike moved raw bytes
behind a 5-byte header; the real frame header is **20 bytes** fixed (magic, op,
flags, bus index, select, seq, a 64-bit-range nanosecond timestamp, payload
length). Measured on the dev Mac (Darwin 25.5.0 arm64, Node 25):

| Payload | Header share of bytes | encode + decode | throughput |
|---|---|---|---|
| 1-byte transaction | 95.2% | ~110 ns | — |
| full 153,600-byte frame | 0.013% | ~4 µs | ~35 GiB/s |

Encoding and decoding a whole display frame costs **~0.004 ms** — under 1% of
the spike's 0.62 ms/frame bridge figure, and swamped by the socket round trip
either way. The header does not move the batched conclusion. The per-transaction
budget is still counted in *frames*: one `Xfer` request plus its reply is two
frames and 40 header bytes regardless of transfer size.

**Open question 1 — macOS round trip — first data point, favourable.** A
Unix-domain-socket round trip on the dev Mac measured **~5 µs/transaction**,
against the spike's 48–64 µs on Linux. This is a standalone socket bench, not a
re-run of `spike/run-bench.sh` through a live guest, so the risk-register item
("re-run on macOS before M6") stays open for the full in-guest measurement — but
the headline is that Darwin's IPC is *faster* here, so the §Consequences
per-transaction budget (10 transactions/frame ≈ 0.5 ms) is a conservative
ceiling on this platform, not an optimistic one.

**Open question 4 — blocking-model failure policy — decided.** Models are
synchronous by contract; the host cannot preempt a genuine infinite loop
without hanging itself, so the real backstop for a hung guest is the C-side
socket read timeout the SPI controller gets in M6 (after it, the guest sees
0xFF and its controller raises a guest diagnostic). On the host side
(`src/main/devices.ts`): a model that **throws** is quarantined — its bus
replies become all-`0xFF` (never silent zeros, per M8's rule) and a named
`error` diagnostic is raised, until the next `Reset`; a call that **runs long**
(> 50 ms) raises a one-shot `warn` naming the model; a reply of the wrong
length is padded/truncated to the request length with a diagnostic.

**Open question 2 — transaction-shaped interface — done.** `DeviceModel.onBus`
takes a whole `BusTransaction` and returns a whole `BusResponse`; there is no
byte-level entry point. The bulk hook in QEMU's `ssi_transfer()` path remains
M6's to build — nothing in M4 needed it, because the LED is on a GPIO, not a
bus, and the fork's GPIO peripheral turned out to be a stub (see the M4 roadmap
outcome).
