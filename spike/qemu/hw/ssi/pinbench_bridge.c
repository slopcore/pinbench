/*
 * PinBench M0 spike - SPI-over-Unix-socket bridge peripheral.
 *
 * An SSI peripheral that forwards every transaction to a device model hosted
 * in a Node process, over a Unix domain socket. Deliberately synchronous and
 * deliberately dumb: the point is to measure what the transport costs, not to
 * be a good design.
 *
 * Throwaway. See docs/adr/0001-device-model-boundary.md.
 */

#include "qemu/osdep.h"
#include "qemu/log.h"
#include "qemu/module.h"
#include "hw/hw.h"
#include "hw/ssi/ssi.h"
#include "hw/qdev-properties.h"
#include "qapi/error.h"
#include "hw/misc/pinbench_bridge.h"

#include <sys/socket.h>
#include <sys/un.h>

static bool sock_write_all(int fd, const void *buf, size_t len)
{
    const uint8_t *p = buf;
    while (len) {
        ssize_t n = write(fd, p, len);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            return false;
        }
        p += n;
        len -= n;
    }
    return true;
}

static bool sock_read_all(int fd, void *buf, size_t len)
{
    uint8_t *p = buf;
    while (len) {
        ssize_t n = read(fd, p, len);
        if (n < 0) {
            if (errno == EINTR) {
                continue;
            }
            return false;
        }
        if (n == 0) {
            return false;
        }
        p += n;
        len -= n;
    }
    return true;
}

/* [op:u8][len:u32 LE][payload] */
static bool send_header(int fd, uint8_t op, uint32_t len)
{
    uint8_t hdr[5];
    hdr[0] = op;
    hdr[1] = len & 0xff;
    hdr[2] = (len >> 8) & 0xff;
    hdr[3] = (len >> 16) & 0xff;
    hdr[4] = (len >> 24) & 0xff;
    return sock_write_all(fd, hdr, sizeof(hdr));
}

bool pinbench_bridge_xfer(PinbenchBridgeState *s, uint8_t tx, uint8_t *rx)
{
    if (s->fd < 0) {
        return false;
    }
    uint8_t frame[6];
    frame[0] = PINBENCH_OP_XFER;
    frame[1] = 1; frame[2] = 0; frame[3] = 0; frame[4] = 0;
    frame[5] = tx;
    /* One write, not header-then-payload: two writes would be two syscalls
     * and, on a stream socket, would flatter nothing but our syscall count. */
    if (!sock_write_all(s->fd, frame, sizeof(frame))) {
        return false;
    }
    if (!sock_read_all(s->fd, rx, 1)) {
        return false;
    }
    s->n_xfer++;
    s->n_bytes++;
    return true;
}

bool pinbench_bridge_burst(PinbenchBridgeState *s, const uint8_t *tx,
                           uint8_t *rx, size_t len)
{
    if (s->fd < 0 || len == 0) {
        return false;
    }
    if (!send_header(s->fd, PINBENCH_OP_BURST, len)) {
        return false;
    }
    if (!sock_write_all(s->fd, tx, len)) {
        return false;
    }
    if (!sock_read_all(s->fd, rx, len)) {
        return false;
    }
    s->n_burst++;
    s->n_bytes += len;
    return true;
}

bool pinbench_bridge_reset_host(PinbenchBridgeState *s)
{
    uint8_t frame[5], ack;

    if (s->fd < 0) {
        return false;
    }
    frame[0] = PINBENCH_OP_RESET;
    frame[1] = frame[2] = frame[3] = frame[4] = 0;
    if (!sock_write_all(s->fd, frame, sizeof(frame)) ||
        !sock_read_all(s->fd, &ack, 1)) {
        return false;
    }
    s->n_xfer = s->n_burst = s->n_bytes = 0;
    return true;
}

static uint32_t pinbench_bridge_transfer(SSIPeripheral *dev, uint32_t val)
{
    PinbenchBridgeState *s = PINBENCH_BRIDGE(dev);
    uint8_t rx = 0xff;

    if (!pinbench_bridge_xfer(s, val & 0xff, &rx)) {
        qemu_log_mask(LOG_GUEST_ERROR, "pinbench-bridge: transfer failed\n");
        return 0xff;
    }
    return rx;
}

static int pinbench_bridge_set_cs(SSIPeripheral *dev, bool select)
{
    PinbenchBridgeState *s = PINBENCH_BRIDGE(dev);
    uint8_t frame[7];
    uint8_t ack;

    if (s->fd < 0) {
        return 0;
    }
    frame[0] = PINBENCH_OP_CS;
    frame[1] = 2; frame[2] = 0; frame[3] = 0; frame[4] = 0;
    frame[5] = dev->cs_index;
    frame[6] = select ? 1 : 0;
    if (!sock_write_all(s->fd, frame, sizeof(frame)) ||
        !sock_read_all(s->fd, &ack, 1)) {
        qemu_log_mask(LOG_GUEST_ERROR, "pinbench-bridge: cs failed\n");
    }
    return 0;
}

static void pinbench_bridge_realize(SSIPeripheral *dev, Error **errp)
{
    PinbenchBridgeState *s = PINBENCH_BRIDGE(dev);
    struct sockaddr_un addr;
    uint8_t frame[5], ack;

    s->fd = -1;
    if (!s->path || !s->path[0]) {
        error_setg(errp, "pinbench-bridge: 'path' property is required");
        return;
    }
    if (strlen(s->path) >= sizeof(addr.sun_path)) {
        error_setg(errp, "pinbench-bridge: socket path too long");
        return;
    }

    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        error_setg_errno(errp, errno, "pinbench-bridge: socket()");
        return;
    }
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strcpy(addr.sun_path, s->path);
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        error_setg_errno(errp, errno, "pinbench-bridge: connect(%s)", s->path);
        close(fd);
        return;
    }

    /* Nagle is off by definition on AF_UNIX, but the handshake proves the
     * host is alive before the guest depends on it. */
    frame[0] = PINBENCH_OP_PING;
    frame[1] = frame[2] = frame[3] = frame[4] = 0;
    if (!sock_write_all(fd, frame, sizeof(frame)) ||
        !sock_read_all(fd, &ack, 1)) {
        error_setg(errp, "pinbench-bridge: handshake failed");
        close(fd);
        return;
    }

    s->fd = fd;
    qemu_log("pinbench-bridge: connected to %s\n", s->path);
}

static void pinbench_bridge_unrealize(DeviceState *dev)
{
    PinbenchBridgeState *s = PINBENCH_BRIDGE(dev);

    if (s->fd >= 0) {
        close(s->fd);
        s->fd = -1;
    }
}

static Property pinbench_bridge_props[] = {
    DEFINE_PROP_STRING("path", PinbenchBridgeState, path),
    DEFINE_PROP_END_OF_LIST(),
};

static void pinbench_bridge_class_init(ObjectClass *klass, void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);
    SSIPeripheralClass *k = SSI_PERIPHERAL_CLASS(klass);

    k->realize = pinbench_bridge_realize;
    k->transfer = pinbench_bridge_transfer;
    k->set_cs = pinbench_bridge_set_cs;
    k->cs_polarity = SSI_CS_LOW;
    dc->unrealize = pinbench_bridge_unrealize;
    dc->desc = "PinBench spike SPI-over-unix-socket bridge";
    device_class_set_props(dc, pinbench_bridge_props);
}

static const TypeInfo pinbench_bridge_info = {
    .name          = TYPE_PINBENCH_BRIDGE,
    .parent        = TYPE_SSI_PERIPHERAL,
    .instance_size = sizeof(PinbenchBridgeState),
    .class_init    = pinbench_bridge_class_init,
};

static void pinbench_bridge_register_types(void)
{
    type_register_static(&pinbench_bridge_info);
}

type_init(pinbench_bridge_register_types)
