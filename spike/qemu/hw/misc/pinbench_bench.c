/*
 * PinBench M0 spike - measurement harness.
 *
 * Two devices:
 *
 *   pinbench-native  an SSI peripheral implementing the same trivial
 *                    "display-like" byte sink as the Node-hosted model, but
 *                    in C, in-process. The control against which the bridge
 *                    is measured.
 *
 *   pinbench-bench   a memory-mapped stopwatch. Firmware writes mode, length
 *                    and iteration count, writes GO, and reads back elapsed
 *                    nanoseconds and a checksum of the received bytes. The
 *                    run happens synchronously inside the MMIO write, which
 *                    is exactly what a blocking device model does to a vCPU.
 *
 * Throwaway. See docs/adr/0001-device-model-boundary.md.
 */

#include "qemu/osdep.h"
#include "qemu/log.h"
#include "qemu/module.h"
#include "hw/hw.h"
#include "hw/sysbus.h"
#include "hw/ssi/ssi.h"
#include "hw/qdev-properties.h"
#include "hw/irq.h"
#include "qom/object.h"
#include "qapi/error.h"
#include "hw/misc/pinbench_bridge.h"
#include "hw/misc/pinbench_bench.h"

#include <time.h>

/* 320x240x16bpp - one ST7789 full-frame flush, the number that matters. */
#define PINBENCH_FB_BYTES (320 * 240 * 2)

/* ---------------------------------------------------------------- sink --- */

typedef struct PinbenchSink {
    uint8_t *fb;
    uint32_t cursor;
} PinbenchSink;

static void pinbench_sink_init(PinbenchSink *sink)
{
    sink->fb = g_malloc0(PINBENCH_FB_BYTES);
    sink->cursor = 0;
}

static void pinbench_sink_reset(PinbenchSink *sink)
{
    memset(sink->fb, 0, PINBENCH_FB_BYTES);
    sink->cursor = 0;
}

/* Must stay byte-for-byte identical to the JS implementation in
 * spike/bridge-server/server.mjs, or the checksums will not match. */
/* The bulk path a native model can take and a per-byte API cannot: move the
 * whole transfer with memcpy instead of a call per byte. */
static void pinbench_sink_bulk(PinbenchSink *sink, const uint8_t *tx,
                               uint8_t *rx, uint32_t len)
{
    uint32_t done = 0;

    while (done < len) {
        uint32_t chunk = MIN(len - done, PINBENCH_FB_BYTES - sink->cursor);
        memcpy(rx + done, sink->fb + sink->cursor, chunk);
        memcpy(sink->fb + sink->cursor, tx + done, chunk);
        sink->cursor += chunk;
        if (sink->cursor == PINBENCH_FB_BYTES) {
            sink->cursor = 0;
        }
        done += chunk;
    }
}

static inline uint8_t pinbench_sink_byte(PinbenchSink *sink, uint8_t tx)
{
    uint8_t rx = sink->fb[sink->cursor];
    sink->fb[sink->cursor] = tx;
    sink->cursor++;
    if (sink->cursor == PINBENCH_FB_BYTES) {
        sink->cursor = 0;
    }
    return rx;
}

/* ------------------------------------------------- native SSI peripheral - */

#define TYPE_PINBENCH_NATIVE "pinbench-native"
OBJECT_DECLARE_SIMPLE_TYPE(PinbenchNativeState, PINBENCH_NATIVE)

struct PinbenchNativeState {
    SSIPeripheral parent_obj;
    PinbenchSink sink;
};

static uint32_t pinbench_native_transfer(SSIPeripheral *dev, uint32_t val)
{
    PinbenchNativeState *s = PINBENCH_NATIVE(dev);
    return pinbench_sink_byte(&s->sink, val & 0xff);
}

static void pinbench_native_realize(SSIPeripheral *dev, Error **errp)
{
    PinbenchNativeState *s = PINBENCH_NATIVE(dev);
    pinbench_sink_init(&s->sink);
}

static void pinbench_native_class_init(ObjectClass *klass, void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);
    SSIPeripheralClass *k = SSI_PERIPHERAL_CLASS(klass);

    k->realize = pinbench_native_realize;
    k->transfer = pinbench_native_transfer;
    k->cs_polarity = SSI_CS_LOW;
    dc->desc = "PinBench spike native (in-process C) device model";
}

static const TypeInfo pinbench_native_info = {
    .name          = TYPE_PINBENCH_NATIVE,
    .parent        = TYPE_SSI_PERIPHERAL,
    .instance_size = sizeof(PinbenchNativeState),
    .class_init    = pinbench_native_class_init,
};

/* ------------------------------------------------------- bench MMIO dev -- */

#define TYPE_PINBENCH_BENCH "pinbench-bench"
OBJECT_DECLARE_SIMPLE_TYPE(PinbenchBenchState, PINBENCH_BENCH)

enum {
    PINBENCH_MODE_NATIVE_DIRECT = 0, /* C model, one call per byte          */
    PINBENCH_MODE_BRIDGE_BYTE   = 1, /* socket round trip per byte          */
    PINBENCH_MODE_BRIDGE_BURST  = 2, /* whole buffer, one round trip        */
    PINBENCH_MODE_NATIVE_BURST  = 3, /* C model, whole buffer, one call     */
    PINBENCH_MODE_SSI_NATIVE    = 4, /* ssi_transfer() -> C model           */
    PINBENCH_MODE_SSI_BRIDGE    = 5, /* ssi_transfer() -> bridge, per byte  */
    PINBENCH_MODE_MAX
};

#define R_MODE      0x00
#define R_LEN       0x04
#define R_ITERS     0x08
#define R_GO        0x0c
#define R_NS_LO     0x10
#define R_NS_HI     0x14
#define R_CHECKSUM  0x18
#define R_STATUS    0x1c
#define R_MAGIC     0x20

#define PINBENCH_MAGIC 0x50424e31 /* "PBN1" */

struct PinbenchBenchState {
    SysBusDevice parent_obj;
    MemoryRegion iomem;

    uint32_t mode;
    uint32_t len;
    uint32_t iters;
    uint64_t elapsed_ns;
    uint32_t checksum;
    uint32_t status;

    /* Filled in by the machine. */
    PinbenchBridgeState *bridge;
    PinbenchNativeState *native;
    SSIBus *ssi_bus;
    uint8_t bridge_cs;
    uint8_t native_cs;

    PinbenchSink direct_sink;
    uint8_t *tx;
    uint8_t *rx;
    uint32_t buf_cap;
};

/* CS is active low, so level 0 selects. */
static void pinbench_select(DeviceState *dev, bool selected)
{
    qemu_set_irq(qdev_get_gpio_in_named(dev, SSI_GPIO_CS, 0), selected ? 0 : 1);
}

static uint64_t now_ns(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ull + ts.tv_nsec;
}

static void pinbench_fill_tx(PinbenchBenchState *s)
{
    /* A gradient, not zeroes: a run of identical bytes is exactly the input
     * that would let some future compression in the transport cheat. */
    for (uint32_t i = 0; i < s->len; i++) {
        s->tx[i] = (uint8_t)(i * 7 + 13);
    }
}

static void pinbench_ensure_buffers(PinbenchBenchState *s)
{
    if (s->buf_cap >= s->len) {
        return;
    }
    g_free(s->tx);
    g_free(s->rx);
    s->tx = g_malloc(s->len);
    s->rx = g_malloc(s->len);
    s->buf_cap = s->len;
}

static uint32_t fnv1a(const uint8_t *p, uint32_t len)
{
    uint32_t h = 2166136261u;
    for (uint32_t i = 0; i < len; i++) {
        h ^= p[i];
        h *= 16777619u;
    }
    return h;
}

static void pinbench_run(PinbenchBenchState *s)
{
    uint64_t t0, t1;

    s->status = 0;
    s->checksum = 0;
    s->elapsed_ns = 0;

    if (s->len == 0 || s->iters == 0 || s->mode >= PINBENCH_MODE_MAX) {
        s->status = 1;
        return;
    }
    if ((s->mode == PINBENCH_MODE_BRIDGE_BYTE ||
         s->mode == PINBENCH_MODE_BRIDGE_BURST ||
         s->mode == PINBENCH_MODE_SSI_BRIDGE) && !s->bridge) {
        s->status = 2; /* no -device pinbench-bridge on the command line */
        return;
    }

    pinbench_ensure_buffers(s);
    pinbench_fill_tx(s);

    /* Reset both models so checksums are comparable across modes. */
    pinbench_sink_reset(&s->direct_sink);
    if (s->native) {
        pinbench_sink_reset(&s->native->sink);
    }
    if (s->bridge) {
        pinbench_bridge_reset_host(s->bridge);
    }

    if (s->mode == PINBENCH_MODE_SSI_NATIVE ||
        s->mode == PINBENCH_MODE_SSI_BRIDGE) {
        if (!s->ssi_bus || !s->native || !s->bridge) {
            s->status = 4;
            return;
        }
        /* Exactly one peripheral selected. ssi_transfer() broadcasts to every
         * child, and an SSI_CS_LOW device transfers whenever its CS input is
         * low - which is its power-on state. Leaving the other one selected
         * silently doubles the work and was worth an hour of confusion. */
        pinbench_select(DEVICE(s->native), s->mode == PINBENCH_MODE_SSI_NATIVE);
        pinbench_select(DEVICE(s->bridge), s->mode == PINBENCH_MODE_SSI_BRIDGE);
    }

    t0 = now_ns();
    for (uint32_t it = 0; it < s->iters; it++) {
        switch (s->mode) {
        case PINBENCH_MODE_NATIVE_DIRECT:
            for (uint32_t i = 0; i < s->len; i++) {
                s->rx[i] = pinbench_sink_byte(&s->direct_sink, s->tx[i]);
            }
            break;

        case PINBENCH_MODE_NATIVE_BURST:
            pinbench_sink_bulk(&s->direct_sink, s->tx, s->rx, s->len);
            break;

        case PINBENCH_MODE_BRIDGE_BYTE:
            for (uint32_t i = 0; i < s->len; i++) {
                if (!pinbench_bridge_xfer(s->bridge, s->tx[i], &s->rx[i])) {
                    s->status = 3;
                    goto done;
                }
            }
            break;

        case PINBENCH_MODE_BRIDGE_BURST:
            if (!pinbench_bridge_burst(s->bridge, s->tx, s->rx, s->len)) {
                s->status = 3;
                goto done;
            }
            break;

        case PINBENCH_MODE_SSI_NATIVE:
        case PINBENCH_MODE_SSI_BRIDGE:
            for (uint32_t i = 0; i < s->len; i++) {
                s->rx[i] = ssi_transfer(s->ssi_bus, s->tx[i]) & 0xff;
            }
            break;

        default:
            s->status = 1;
            goto done;
        }
    }
done:
    t1 = now_ns();

    if (s->mode == PINBENCH_MODE_SSI_NATIVE ||
        s->mode == PINBENCH_MODE_SSI_BRIDGE) {
        pinbench_select(DEVICE(s->native), false);
        pinbench_select(DEVICE(s->bridge), false);
    }

    s->elapsed_ns = t1 - t0;
    s->checksum = fnv1a(s->rx, s->len);
}

static uint64_t pinbench_bench_read(void *opaque, hwaddr addr, unsigned size)
{
    PinbenchBenchState *s = PINBENCH_BENCH(opaque);

    switch (addr) {
    case R_MODE:     return s->mode;
    case R_LEN:      return s->len;
    case R_ITERS:    return s->iters;
    case R_NS_LO:    return (uint32_t)(s->elapsed_ns & 0xffffffffu);
    case R_NS_HI:    return (uint32_t)(s->elapsed_ns >> 32);
    case R_CHECKSUM: return s->checksum;
    case R_STATUS:   return s->status;
    case R_MAGIC:    return PINBENCH_MAGIC;
    default:         return 0;
    }
}

static void pinbench_bench_write(void *opaque, hwaddr addr, uint64_t val,
                                 unsigned size)
{
    PinbenchBenchState *s = PINBENCH_BENCH(opaque);

    switch (addr) {
    case R_MODE:  s->mode = val; break;
    case R_LEN:   s->len = val; break;
    case R_ITERS: s->iters = val; break;
    case R_GO:
        if (val) {
            pinbench_run(s);
        }
        break;
    default:
        break;
    }
}

static const MemoryRegionOps pinbench_bench_ops = {
    .read = pinbench_bench_read,
    .write = pinbench_bench_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 4,
    .valid.max_access_size = 4,
};

static void pinbench_bench_realize(DeviceState *dev, Error **errp)
{
    PinbenchBenchState *s = PINBENCH_BENCH(dev);
    pinbench_sink_init(&s->direct_sink);
}

static void pinbench_bench_init(Object *obj)
{
    PinbenchBenchState *s = PINBENCH_BENCH(obj);

    memory_region_init_io(&s->iomem, obj, &pinbench_bench_ops, s,
                          TYPE_PINBENCH_BENCH, 0x100);
    sysbus_init_mmio(SYS_BUS_DEVICE(obj), &s->iomem);
}

static void pinbench_bench_class_init(ObjectClass *klass, void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);

    dc->realize = pinbench_bench_realize;
    dc->desc = "PinBench spike measurement harness";
}

static const TypeInfo pinbench_bench_info = {
    .name          = TYPE_PINBENCH_BENCH,
    .parent        = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(PinbenchBenchState),
    .instance_init = pinbench_bench_init,
    .class_init    = pinbench_bench_class_init,
};

static void pinbench_register_types(void)
{
    type_register_static(&pinbench_native_info);
    type_register_static(&pinbench_bench_info);
}

type_init(pinbench_register_types)

/* ------------------------------------------------------------- wiring --- */

void pinbench_spike_attach(MemoryRegion *sys_mem, SSIBus *spi_bus)
{
    const char *sock = getenv("PINBENCH_BRIDGE_SOCKET");
    DeviceState *bridge, *native, *bench;
    PinbenchBenchState *s;

    if (!sock || !sock[0]) {
        return;
    }

    bridge = qdev_new(TYPE_PINBENCH_BRIDGE);
    qdev_prop_set_string(bridge, "path", sock);
    qdev_prop_set_uint8(bridge, "cs", 2);
    qdev_realize_and_unref(bridge, BUS(spi_bus), &error_fatal);

    native = qdev_new(TYPE_PINBENCH_NATIVE);
    qdev_prop_set_uint8(native, "cs", 3);
    qdev_realize_and_unref(native, BUS(spi_bus), &error_fatal);

    bench = qdev_new(TYPE_PINBENCH_BENCH);
    sysbus_realize_and_unref(SYS_BUS_DEVICE(bench), &error_fatal);

    s = PINBENCH_BENCH(bench);
    s->bridge = PINBENCH_BRIDGE(bridge);
    s->native = PINBENCH_NATIVE(native);
    s->ssi_bus = spi_bus;

    /* Both deselected until a run asks for one. */
    pinbench_select(bridge, false);
    pinbench_select(native, false);

    memory_region_add_subregion_overlap(
        sys_mem, PINBENCH_BENCH_BASE,
        sysbus_mmio_get_region(SYS_BUS_DEVICE(bench), 0), 10);

    qemu_log("pinbench: harness at 0x%08x, bridge socket %s\n",
             PINBENCH_BENCH_BASE, sock);
}
