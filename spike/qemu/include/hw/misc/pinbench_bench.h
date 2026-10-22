/*
 * PinBench M0 spike - one-call wiring hook for the measurement harness.
 *
 * Kept behind a single function so the patch to the machine model is three
 * lines, which is what makes this easy to carry across an upstream rebase.
 */
#ifndef PINBENCH_BENCH_H
#define PINBENCH_BENCH_H

#include "exec/memory.h"
#include "hw/ssi/ssi.h"

/*
 * No-op unless PINBENCH_BRIDGE_SOCKET is set in the environment. When it is,
 * attaches a pinbench-bridge (CS 2) and a pinbench-native (CS 3) to @spi_bus
 * and maps the pinbench-bench harness into @sys_mem.
 *
 * An environment variable rather than a machine property on purpose: this is
 * throwaway measurement scaffolding and should not grow a CLI surface that
 * later looks like a supported feature.
 */
void pinbench_spike_attach(MemoryRegion *sys_mem, SSIBus *spi_bus);

/* Where firmware finds the harness. Unused peripheral space on the S3. */
#define PINBENCH_BENCH_BASE 0x60041000

#endif /* PINBENCH_BENCH_H */
