/*
 * PinBench device-host bridge — QEMU side.
 *
 * A blocking Unix-domain-socket client that carries whole SPI transactions and
 * GPIO edges from the emulated ESP32-S3 to the PinBench main process, where the
 * TypeScript device models live (ADR 0001). The wire format is the 20-byte
 * header defined in src/shared/devices/protocol.ts — kept byte-identical here.
 *
 * The connection is a singleton keyed by the PINBENCH_DEVICE_SOCKET environment
 * variable, which PinBench's EmulatorSupervisor sets on the QEMU child. With
 * the variable unset every call is a no-op and the guest talks to nothing —
 * the pre-M6 behaviour, so a stock `qemu-system-xtensa` invocation is
 * unaffected.
 */
#ifndef HW_MISC_PINBENCH_HOST_H
#define HW_MISC_PINBENCH_HOST_H

#include "qemu/osdep.h"
#include "exec/memory.h"

/* Wire protocol — mirror of src/shared/devices/protocol.ts. */
#define PINBENCH_FRAME_MAGIC   0x9b
#define PINBENCH_FRAME_HDR     20
#define PINBENCH_BUS_NONE      0xff
#define PINBENCH_SELECT_NONE   0xffff

enum {
    PINBENCH_OP_HELLO     = 0x01,
    PINBENCH_OP_XFER      = 0x02,
    PINBENCH_OP_SIGNAL    = 0x03,
    PINBENCH_OP_RESET     = 0x04,
    PINBENCH_OP_GPIO_READ = 0x06,
    PINBENCH_OP_GPIO      = 0x05,
};

typedef struct PinbenchHost PinbenchHost;

/*
 * The process-wide host connection, or NULL if PINBENCH_DEVICE_SOCKET is unset
 * or the connect failed. Safe to call repeatedly; connects lazily on the first
 * call and logs once on failure.
 */
PinbenchHost *pinbench_host_get(void);

/*
 * One whole SPI transaction on board bus `bus_index`. `tx`/`rx` are `len`
 * bytes; `rx` may alias `tx`. Blocks the calling vCPU until the model replies
 * or the socket read times out (after which `rx` is filled with 0xFF and a
 * guest-error is logged — never silent zeros). Returns true on a real reply.
 */
bool pinbench_host_xfer(PinbenchHost *h, uint8_t bus_index,
                        const uint8_t *tx, uint8_t *rx, uint32_t len);

/* One GPIO output edge: SoC pin number `pin`, level 0/1. Fire-and-forget. */
void pinbench_host_gpio(PinbenchHost *h, uint32_t pin, int level);

/*
 * The 64-bit mask of SoC input pins the host will answer for — bit N set means
 * a GPIO_IN read of pin N should be routed through pinbench_host_gpio_read()
 * rather than read back the guest's own output drive. Delivered as the 8-byte
 * payload of the Hello reply; 0 if the socket is unset or the host is old.
 */
uint64_t pinbench_host_input_mask(PinbenchHost *h);

/*
 * Read one SoC input pin the host is driving from a device model
 * (LR1110 BUSY / DIO9, GNSS PPS, …). Blocks the vCPU on the reply. Returns
 * 0 or 1; on any socket failure returns 0 (a released line — never 0xFF,
 * because a stuck-high BUSY would hang RadioLib's poll).
 */
int pinbench_host_gpio_read(PinbenchHost *h, uint32_t pin);

/*
 * Instantiate the GP-SPI2 / GP-SPI3 controllers and map them into `sys_mem`.
 * Called once from esp32s3.c after the SoC's own peripherals are on the bus.
 * A no-op-costing addition when the socket is unset — the controllers still
 * exist so guest MMIO does not fault, they just bridge to nothing.
 */
void pinbench_esp32s3_attach(MemoryRegion *sys_mem);

#endif /* HW_MISC_PINBENCH_HOST_H */
