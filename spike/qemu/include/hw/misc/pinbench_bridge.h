/*
 * PinBench M0 spike — SPI-over-Unix-socket bridge peripheral.
 *
 * Throwaway code. Its only job is to produce the numbers behind
 * docs/adr/0001-device-model-boundary.md.
 */
#ifndef PINBENCH_BRIDGE_H
#define PINBENCH_BRIDGE_H

#include "hw/ssi/ssi.h"
#include "qom/object.h"

#define TYPE_PINBENCH_BRIDGE "pinbench-bridge"
OBJECT_DECLARE_SIMPLE_TYPE(PinbenchBridgeState, PINBENCH_BRIDGE)

/* Wire protocol: [op:u8][len:u32 LE][payload:len]. Replies are raw bytes,
 * the count implied by the op. Deliberately the dumbest thing that works. */
enum {
    PINBENCH_OP_XFER  = 0x01, /* len==1, reply 1 byte  */
    PINBENCH_OP_BURST = 0x02, /* len==n, reply n bytes */
    PINBENCH_OP_CS    = 0x03, /* len==2 [cs_index, level], reply 1 byte */
    PINBENCH_OP_PING  = 0x04, /* len==0, reply 1 byte  */
    PINBENCH_OP_RESET = 0x05, /* len==0, reply 1 byte  */
};

struct PinbenchBridgeState {
    SSIPeripheral parent_obj;

    char *path;          /* unix socket the device host listens on */
    int fd;              /* -1 when not connected */
    uint64_t n_xfer;     /* stats, read back by the bench device */
    uint64_t n_burst;
    uint64_t n_bytes;
};

/* Both return false and log on transport failure. */
bool pinbench_bridge_xfer(PinbenchBridgeState *s, uint8_t tx, uint8_t *rx);
bool pinbench_bridge_burst(PinbenchBridgeState *s, const uint8_t *tx,
                           uint8_t *rx, size_t len);
bool pinbench_bridge_reset_host(PinbenchBridgeState *s);

#endif /* PINBENCH_BRIDGE_H */
