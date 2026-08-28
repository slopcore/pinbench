/*
 * PinBench GP-SPI2 / GP-SPI3 controller for the emulated ESP32-S3.
 *
 * The Espressif QEMU fork models only SPI1 — the flash/PSRAM memory controller
 * (`SPI_MEM_*` registers). Every peripheral on the ThinkNode M9 (the ST7789
 * panel, the LR1110 radio, the microSD card) hangs off GP-SPI2 (FSPI) or
 * GP-SPI3, which use the different `SPI_*` general-purpose register layout and
 * do not exist in the fork at all. This is that controller, scoped to what the
 * Arduino-ESP32 `SPIClass` FIFO path actually touches:
 *
 *   - `SPI_CMD_REG`      bit 24 SPI_USR starts a transfer, bit 23 SPI_UPDATE
 *                        latches config; both self-clear here (synchronous).
 *   - `SPI_MS_DLEN_REG`  bits 17:0 hold (data_bits - 1).
 *   - `SPI_USER_REG` / `USER1` / `USER2`  accepted; MOSI/MISO bits observed.
 *   - `SPI_W0_REG`..`SPI_W15_REG` (0x98..0xD4)  the 64-byte CPU FIFO.
 *   - everything else is absorbed into a backing array so a driver's clock,
 *     DMA and timing pokes read back what was written and nothing faults.
 *
 * On an `SPI_USR` pulse the whole FIFO window for the transfer is handed to the
 * PinBench device host in a single socket round trip — the "bulk hook" ADR 0001
 * requires so a framebuffer flush is one transaction, not thousands. Chip
 * selects are plain GPIOs the firmware drives itself, so this controller does
 * not model CS; the host routes by the GPIO edges it observes.
 */
#include "qemu/osdep.h"
#include "qemu/log.h"
#include "qemu/module.h"
#include "hw/hw.h"
#include "hw/sysbus.h"
#include "hw/qdev-properties.h"
#include "qapi/error.h"
#include "hw/misc/pinbench_host.h"

#define TYPE_PINBENCH_GPSPI "pinbench.gpspi"
#define PINBENCH_GPSPI(obj) OBJECT_CHECK(PinbenchGpspiState, (obj), TYPE_PINBENCH_GPSPI)

#define GPSPI_IO_SIZE   0x1000
#define REG_SPI_CMD     0x00
#define REG_SPI_USER    0x10
#define REG_SPI_USER1   0x14
#define REG_SPI_USER2   0x18
#define REG_SPI_MS_DLEN 0x1c
#define REG_SPI_MISC    0x20
#define REG_SPI_W0      0x98
#define REG_SPI_W15     0xd4

#define SPI_CMD_UPDATE  (1u << 23)
#define SPI_CMD_USR     (1u << 24)
#define SPI_USER_MOSI   (1u << 27)
#define SPI_USER_MISO   (1u << 28)

#define GPSPI_FIFO_BYTES 64

typedef struct PinbenchGpspiState {
    SysBusDevice parent_obj;
    MemoryRegion iomem;
    uint8_t bus_index;
    uint32_t regs[GPSPI_IO_SIZE / 4];
} PinbenchGpspiState;

static uint8_t *fifo_bytes(PinbenchGpspiState *s)
{
    return (uint8_t *) &s->regs[REG_SPI_W0 / 4];
}

static void gpspi_do_user_transfer(PinbenchGpspiState *s)
{
    uint32_t dlen = s->regs[REG_SPI_MS_DLEN / 4] & 0x3ffff; /* bits - 1 */
    uint32_t nbytes = (dlen + 1 + 7) / 8;
    if (nbytes == 0) {
        return;
    }
    if (nbytes > GPSPI_FIFO_BYTES) {
        nbytes = GPSPI_FIFO_BYTES;
    }

    uint8_t buf[GPSPI_FIFO_BYTES];
    memcpy(buf, fifo_bytes(s), nbytes);

    PinbenchHost *host = pinbench_host_get();
    pinbench_host_xfer(host, s->bus_index, buf, buf, nbytes);

    /* MISO lands back in the FIFO where the driver reads it. */
    memcpy(fifo_bytes(s), buf, nbytes);
}

static uint64_t gpspi_read(void *opaque, hwaddr addr, unsigned size)
{
    PinbenchGpspiState *s = opaque;
    if (addr + 4 > GPSPI_IO_SIZE) {
        return 0;
    }
    return s->regs[addr / 4];
}

static void gpspi_write(void *opaque, hwaddr addr, uint64_t val, unsigned size)
{
    PinbenchGpspiState *s = opaque;
    if (addr + 4 > GPSPI_IO_SIZE) {
        return;
    }

    if (addr == REG_SPI_CMD) {
        if (val & SPI_CMD_USR) {
            gpspi_do_user_transfer(s);
        }
        /* USR and UPDATE both complete synchronously — never leave them set,
         * or the driver's `while (hw->cmd.usr)` / `.update` spin never ends. */
        s->regs[REG_SPI_CMD / 4] = val & ~(SPI_CMD_USR | SPI_CMD_UPDATE);
        return;
    }

    s->regs[addr / 4] = val;
}

static const MemoryRegionOps gpspi_ops = {
    .read = gpspi_read,
    .write = gpspi_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 4,
    .valid.max_access_size = 4,
};

static void gpspi_reset_hold(Object *obj, ResetType type)
{
    PinbenchGpspiState *s = PINBENCH_GPSPI(obj);
    memset(s->regs, 0, sizeof(s->regs));
    /* Power-on default the driver expects: full-duplex user transfer. */
    s->regs[REG_SPI_USER / 4] = SPI_USER_MOSI | SPI_USER_MISO;
}

static void gpspi_init(Object *obj)
{
    PinbenchGpspiState *s = PINBENCH_GPSPI(obj);
    memory_region_init_io(&s->iomem, obj, &gpspi_ops, s,
                          TYPE_PINBENCH_GPSPI, GPSPI_IO_SIZE);
    sysbus_init_mmio(SYS_BUS_DEVICE(obj), &s->iomem);
}

static Property gpspi_props[] = {
    DEFINE_PROP_UINT8("bus-index", PinbenchGpspiState, bus_index, 0),
    DEFINE_PROP_END_OF_LIST(),
};

static void gpspi_class_init(ObjectClass *klass, void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);
    ResettableClass *rc = RESETTABLE_CLASS(klass);
    rc->phases.hold = gpspi_reset_hold;
    dc->desc = "PinBench ESP32-S3 GP-SPI controller (socket bridge to TS models)";
    device_class_set_props(dc, gpspi_props);
}

static const TypeInfo gpspi_info = {
    .name = TYPE_PINBENCH_GPSPI,
    .parent = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(PinbenchGpspiState),
    .instance_init = gpspi_init,
    .class_init = gpspi_class_init,
};

static void gpspi_register_types(void)
{
    type_register_static(&gpspi_info);
}

type_init(gpspi_register_types)
