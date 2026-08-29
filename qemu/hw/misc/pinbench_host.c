/*
 * PinBench device-host bridge — QEMU side. See include/hw/misc/pinbench_host.h.
 */
#include "qemu/osdep.h"
#include "qemu/log.h"
#include "qemu/error-report.h"
#include "qemu/timer.h"
#include "hw/misc/pinbench_host.h"

#include <sys/socket.h>
#include <sys/un.h>

/* The vCPU blocks on the model's reply. This bounds a hung model — after it,
 * the guest sees 0xFF (loud, never silent zeros) and its driver can time out.
 * The M4 failure-policy note names this as the real backstop. */
#define PINBENCH_READ_TIMEOUT_MS 2000

struct PinbenchHost {
    int fd;
    uint16_t seq;
    bool warned;
    uint64_t input_mask; /* SoC input pins the host answers GPIO_IN for */
};

static bool write_all(int fd, const void *buf, size_t len)
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

static bool read_all(int fd, void *buf, size_t len)
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

static uint32_t get_le32(const uint8_t *p)
{
    return (uint32_t) p[0] | ((uint32_t) p[1] << 8) |
           ((uint32_t) p[2] << 16) | ((uint32_t) p[3] << 24);
}

static void put_le16(uint8_t *p, uint16_t v) { p[0] = v; p[1] = v >> 8; }
static void put_le32(uint8_t *p, uint32_t v)
{
    p[0] = v; p[1] = v >> 8; p[2] = v >> 16; p[3] = v >> 24;
}

static void encode_header(uint8_t *hdr, uint8_t op, uint8_t bus,
                          uint16_t select, uint16_t seq, uint32_t len)
{
    uint64_t t = (uint64_t) qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL);
    memset(hdr, 0, PINBENCH_FRAME_HDR);
    hdr[0] = PINBENCH_FRAME_MAGIC;
    hdr[1] = op;
    hdr[2] = 0; /* flags: not a reply */
    hdr[3] = bus;
    put_le16(hdr + 4, select);
    put_le16(hdr + 6, seq);
    put_le32(hdr + 8, (uint32_t) t);
    put_le32(hdr + 12, (uint32_t) (t >> 32));
    put_le32(hdr + 16, len);
}

PinbenchHost *pinbench_host_get(void)
{
    static PinbenchHost *host;
    static bool tried;

    if (tried) {
        return host;
    }
    tried = true;

    const char *path = getenv("PINBENCH_DEVICE_SOCKET");
    if (!path || !path[0]) {
        return NULL;
    }

    struct sockaddr_un addr;
    if (strlen(path) >= sizeof(addr.sun_path)) {
        warn_report("pinbench: PINBENCH_DEVICE_SOCKET path too long");
        return NULL;
    }

    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
        warn_report("pinbench: socket(): %s", strerror(errno));
        return NULL;
    }
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strcpy(addr.sun_path, path);
    if (connect(fd, (struct sockaddr *) &addr, sizeof(addr)) < 0) {
        warn_report("pinbench: connect(%s): %s — device models will not run",
                    path, strerror(errno));
        close(fd);
        return NULL;
    }

    struct timeval tv = {
        .tv_sec = PINBENCH_READ_TIMEOUT_MS / 1000,
        .tv_usec = (PINBENCH_READ_TIMEOUT_MS % 1000) * 1000,
    };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    host = g_new0(PinbenchHost, 1);
    host->fd = fd;

    /* Handshake so a misconfigured socket fails here, not mid-boot. */
    uint8_t hdr[PINBENCH_FRAME_HDR];
    encode_header(hdr, PINBENCH_OP_HELLO, PINBENCH_BUS_NONE,
                  PINBENCH_SELECT_NONE, host->seq++, 3);
    if (!write_all(fd, hdr, sizeof(hdr)) || !write_all(fd, "pb1", 3) ||
        !read_all(fd, hdr, PINBENCH_FRAME_HDR)) {
        warn_report("pinbench: handshake failed — device models will not run");
        close(fd);
        g_free(host);
        host = NULL;
        return NULL;
    }
    /*
     * The Hello reply payload is the 8-byte little-endian mask of SoC input
     * pins the host will answer GPIO_IN reads for (M7). An older host echoed
     * the 3-byte "pb1" tag instead — tolerate any length, only an exact 8
     * bytes is read as a mask.
     */
    uint32_t plen = get_le32(hdr + 16);
    if (plen == 8) {
        uint8_t buf[8];
        if (read_all(fd, buf, 8)) {
            for (int i = 0; i < 8; i++) {
                host->input_mask |= (uint64_t) buf[i] << (8 * i);
            }
        }
    } else {
        uint8_t drain[64];
        while (plen) {
            uint32_t n = plen > sizeof(drain) ? sizeof(drain) : plen;
            if (!read_all(fd, drain, n)) {
                break;
            }
            plen -= n;
        }
    }

    qemu_log("pinbench: connected to device host at %s (input mask 0x%016llx)\n",
             path, (unsigned long long) host->input_mask);
    return host;
}

uint64_t pinbench_host_input_mask(PinbenchHost *h)
{
    return h ? h->input_mask : 0;
}

int pinbench_host_gpio_read(PinbenchHost *h, uint32_t pin)
{
    if (!h) {
        return 0;
    }

    uint8_t hdr[PINBENCH_FRAME_HDR];
    encode_header(hdr, PINBENCH_OP_GPIO_READ, PINBENCH_BUS_NONE,
                  (uint16_t) pin, h->seq++, 0);

    if (!write_all(h->fd, hdr, sizeof(hdr)) ||
        !read_all(h->fd, hdr, PINBENCH_FRAME_HDR)) {
        goto fail;
    }
    uint32_t rlen = get_le32(hdr + 16);
    if (rlen != 1) {
        goto fail;
    }
    uint8_t level;
    if (!read_all(h->fd, &level, 1)) {
        goto fail;
    }
    return level ? 1 : 0;

fail:
    if (!h->warned) {
        h->warned = true;
        qemu_log_mask(LOG_GUEST_ERROR,
                      "pinbench: GPIO input read failed — line reads low\n");
    }
    return 0;
}

bool pinbench_host_xfer(PinbenchHost *h, uint8_t bus_index,
                        const uint8_t *tx, uint8_t *rx, uint32_t len)
{
    if (!h || len == 0) {
        if (rx && rx != tx) {
            memcpy(rx, tx, len);
        }
        return false;
    }

    uint8_t hdr[PINBENCH_FRAME_HDR];
    encode_header(hdr, PINBENCH_OP_XFER, bus_index, PINBENCH_SELECT_NONE,
                  h->seq++, len);

    if (!write_all(h->fd, hdr, sizeof(hdr)) || !write_all(h->fd, tx, len) ||
        !read_all(h->fd, hdr, PINBENCH_FRAME_HDR)) {
        goto fail;
    }
    uint32_t rlen = hdr[16] | (hdr[17] << 8) | (hdr[18] << 16) | (hdr[19] << 24);
    if (rlen != len) {
        goto fail;
    }
    if (!read_all(h->fd, rx, len)) {
        goto fail;
    }
    return true;

fail:
    if (!h->warned) {
        h->warned = true;
        qemu_log_mask(LOG_GUEST_ERROR,
                      "pinbench: device host stalled or desynced — SPI reads now 0xFF\n");
    }
    memset(rx, 0xff, len);
    return false;
}

void pinbench_host_gpio(PinbenchHost *h, uint32_t pin, int level)
{
    if (!h) {
        return;
    }
    uint8_t hdr[PINBENCH_FRAME_HDR];
    uint8_t lvl = level ? 1 : 0;
    encode_header(hdr, PINBENCH_OP_GPIO, PINBENCH_BUS_NONE,
                  (uint16_t) pin, h->seq++, 1);
    if (!write_all(h->fd, hdr, sizeof(hdr)) || !write_all(h->fd, &lvl, 1)) {
        if (!h->warned) {
            h->warned = true;
            qemu_log_mask(LOG_GUEST_ERROR, "pinbench: GPIO edge lost — host write failed\n");
        }
    }
}
