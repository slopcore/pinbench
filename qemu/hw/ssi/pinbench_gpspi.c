/*
 * PinBench GP-SPI controller for the emulated ESP32-S3 and ESP32-C6.
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
 *
 * ## The `dma` property (ESP32-C6)
 *
 * IDF's `spi_master` — what `esp_lcd` sits on, and so what Waveshare's GC9A01
 * driver uses — moves data through GDMA, not the W0..W15 FIFO, and waits on the
 * `SPI_TRANS_DONE` interrupt rather than on `CMD.USR` clearing. With `dma` set:
 *
 *   - `DMA_INT_RAW/ENA/CLR/ST/SET` (0x3C/0x34/0x38/0x40/0x44) are real: `CLR`
 *     is write-1-to-clear, `SET` sets raw, `ST = RAW & ENA` drives the `irq`.
 *   - `SPI_USR` with `DMA_CONF.DMA_TX_ENA` gathers the MOSI bytes by walking the
 *     GDMA out-link of the channel whose `OUT_PERI_SEL` is SPI2; with
 *     `DMA_RX_ENA` the MISO bytes are scattered into the matching in-link.
 *     The walk is done here rather than via `esp_gdma_read_channel()` because
 *     that helper rebuilds descriptor addresses from the C3's DRAM base
 *     (0x3FC8_0000); C6 SRAM is at 0x4080_0000 (`dram-base`).
 *   - every completed transfer latches `TRANS_DONE` (bit 12).
 *
 * Without `dma` (the S3) behaviour is exactly the FIFO path above.
 */
#include "qemu/osdep.h"
#include "qemu/log.h"
#include "qemu/module.h"
#include "hw/hw.h"
#include "hw/irq.h"
#include "hw/sysbus.h"
#include "hw/qdev-properties.h"
#include "qapi/error.h"
#include "qom/object.h"
#include "exec/address-spaces.h"
#include "sysemu/dma.h"
#include "hw/dma/esp_gdma.h"
#include "hw/misc/pinbench_host.h"

#define TYPE_PINBENCH_GPSPI "pinbench.gpspi"
#define PINBENCH_GPSPI(obj) OBJECT_CHECK(PinbenchGpspiState, (obj), TYPE_PINBENCH_GPSPI)

#define GPSPI_IO_SIZE        0x1000
#define REG_SPI_CMD          0x00
#define REG_SPI_USER         0x10
#define REG_SPI_USER1        0x14
#define REG_SPI_USER2        0x18
#define REG_SPI_MS_DLEN      0x1c
#define REG_SPI_MISC         0x20
#define REG_SPI_DMA_CONF     0x30
#define REG_SPI_DMA_INT_ENA  0x34
#define REG_SPI_DMA_INT_CLR  0x38
#define REG_SPI_DMA_INT_RAW  0x3c
#define REG_SPI_DMA_INT_ST   0x40
#define REG_SPI_DMA_INT_SET  0x44
#define REG_SPI_W0           0x98
#define REG_SPI_W15          0xd4

#define SPI_CMD_UPDATE  (1u << 23)
#define SPI_CMD_USR     (1u << 24)
#define SPI_USER_MOSI   (1u << 27)
#define SPI_USER_MISO   (1u << 28)
#define SPI_DMA_RX_ENA  (1u << 27)
#define SPI_DMA_TX_ENA  (1u << 28)
#define SPI_TRANS_DONE  (1u << 12)

#define GPSPI_FIFO_BYTES 64
/* MS_DLEN is 18 bits of (bits - 1): the largest single transfer. */
#define GPSPI_MAX_BYTES  ((1u << 18) / 8)

/* A GDMA linked-list descriptor (TRM "Linked List"), little-endian in guest RAM. */
#define DESC_SIZE(w)     ((w) & 0xfff)
#define DESC_LENGTH(w)   (((w) >> 12) & 0xfff)
#define DESC_SUC_EOF     (1u << 30)
#define DESC_OWNER       (1u << 31)
#define DESC_MAX_NODES   4096

typedef struct PinbenchGpspiState {
    SysBusDevice parent_obj;
    MemoryRegion iomem;
    qemu_irq irq;
    uint8_t bus_index;
    bool dma;
    uint32_t dram_base;
    uint32_t regs[GPSPI_IO_SIZE / 4];
} PinbenchGpspiState;

static uint8_t *fifo_bytes(PinbenchGpspiState *s)
{
    return (uint8_t *) &s->regs[REG_SPI_W0 / 4];
}

static void gpspi_update_irq(PinbenchGpspiState *s)
{
    uint32_t st = s->regs[REG_SPI_DMA_INT_RAW / 4] & s->regs[REG_SPI_DMA_INT_ENA / 4];
    s->regs[REG_SPI_DMA_INT_ST / 4] = st;
    qemu_set_irq(s->irq, st ? 1 : 0);
}

static ESPGdmaState *gpspi_gdma(void)
{
    bool ambiguous = false;
    Object *o = object_resolve_path_type("", TYPE_ESP_GDMA, &ambiguous);
    return o ? ESP_GDMA(o) : NULL;
}

/*
 * The GDMA channel started for SPI2 in direction `dir`: the one whose
 * PERI_SEL is SPI2 and whose LINK has START pending. Returns its first
 * descriptor's guest address, and clears START the way the hardware does once
 * the peripheral takes the link.
 */
static bool gpspi_take_link(PinbenchGpspiState *s, ESPGdmaState *gdma,
                            int dir, uint32_t *desc_addr)
{
    ESPGdmaClass *klass = ESP_GDMA_GET_CLASS(gdma);
    for (uint32_t chan = 0; chan < klass->m_channel_count; chan++) {
        uint32_t peri = esp_gdma_read_chan_register(gdma, dir, chan, GDMA_PERI_SEL_REG);
        uint32_t link = esp_gdma_read_chan_register(gdma, dir, chan, GDMA_LINK_REG);
        if (peri != GDMA_SPI2 || !FIELD_EX32(link, GDMA_OUT_LINK, START)) {
            continue;
        }
        *desc_addr = (s->dram_base & ~R_GDMA_OUT_LINK_ADDR_MASK) |
                     FIELD_EX32(link, GDMA_OUT_LINK, ADDR);
        esp_gdma_write_chan_register(gdma, dir, chan, GDMA_LINK_REG,
                                     link & R_GDMA_OUT_LINK_ADDR_MASK);
        return true;
    }
    return false;
}

/* Gather up to `len` bytes from an out-link starting at `desc`. Returns bytes read. */
static uint32_t gpspi_dma_gather(uint32_t desc, uint8_t *buf, uint32_t len)
{
    uint32_t got = 0;
    for (int n = 0; desc && got < len && n < DESC_MAX_NODES; n++) {
        uint32_t d[3];
        if (dma_memory_read(&address_space_memory, desc, d, sizeof(d),
                            MEMTXATTRS_UNSPECIFIED) != MEMTX_OK) {
            break;
        }
        uint32_t dw0 = le32_to_cpu(d[0]);
        uint32_t take = MIN(DESC_LENGTH(dw0), len - got);
        if (take && dma_memory_read(&address_space_memory, le32_to_cpu(d[1]),
                                    buf + got, take, MEMTXATTRS_UNSPECIFIED) != MEMTX_OK) {
            break;
        }
        got += take;
        if (dw0 & DESC_SUC_EOF) {
            break;
        }
        desc = le32_to_cpu(d[2]);
    }
    return got;
}

/* Scatter `len` bytes into an in-link starting at `desc`, filling each node's LENGTH. */
static void gpspi_dma_scatter(uint32_t desc, const uint8_t *buf, uint32_t len)
{
    uint32_t put = 0;
    for (int n = 0; desc && put < len && n < DESC_MAX_NODES; n++) {
        uint32_t d[3];
        if (dma_memory_read(&address_space_memory, desc, d, sizeof(d),
                            MEMTXATTRS_UNSPECIFIED) != MEMTX_OK) {
            break;
        }
        uint32_t dw0 = le32_to_cpu(d[0]);
        uint32_t take = MIN(DESC_SIZE(dw0), len - put);
        if (take && dma_memory_write(&address_space_memory, le32_to_cpu(d[1]),
                                     buf + put, take, MEMTXATTRS_UNSPECIFIED) != MEMTX_OK) {
            break;
        }
        put += take;
        dw0 = (dw0 & ~(0xfffu << 12) & ~DESC_OWNER) | (take << 12);
        if (put >= len) {
            dw0 |= DESC_SUC_EOF;
        }
        uint32_t le = cpu_to_le32(dw0);
        dma_memory_write(&address_space_memory, desc, &le, sizeof(le), MEMTXATTRS_UNSPECIFIED);
        desc = le32_to_cpu(d[2]);
    }
}

static void gpspi_do_dma_transfer(PinbenchGpspiState *s, uint32_t nbytes)
{
    uint32_t conf = s->regs[REG_SPI_DMA_CONF / 4];
    ESPGdmaState *gdma = gpspi_gdma();
    uint8_t *buf = g_malloc0(nbytes);
    uint32_t out_desc = 0, in_desc = 0;
    bool have_out = gdma && (conf & SPI_DMA_TX_ENA) &&
                    gpspi_take_link(s, gdma, ESP_GDMA_OUT_IDX, &out_desc);
    bool have_in = gdma && (conf & SPI_DMA_RX_ENA) &&
                   gpspi_take_link(s, gdma, ESP_GDMA_IN_IDX, &in_desc);

    if (have_out) {
        uint32_t got = gpspi_dma_gather(out_desc, buf, nbytes);
        if (got < nbytes) {
            qemu_log_mask(LOG_GUEST_ERROR,
                          "pinbench.gpspi: DMA out-link held %u of %u bytes\n", got, nbytes);
        }
    } else if (s->regs[REG_SPI_USER / 4] & SPI_USER_MOSI) {
        /* TX not on DMA (a short transfer through the FIFO). */
        memcpy(buf, fifo_bytes(s), MIN(nbytes, GPSPI_FIFO_BYTES));
    }

    pinbench_host_xfer(pinbench_host_get(), s->bus_index, buf, buf, nbytes);

    if (have_in) {
        gpspi_dma_scatter(in_desc, buf, nbytes);
    } else {
        memcpy(fifo_bytes(s), buf, MIN(nbytes, GPSPI_FIFO_BYTES));
    }
    g_free(buf);
}

static void gpspi_do_user_transfer(PinbenchGpspiState *s)
{
    uint32_t dlen = s->regs[REG_SPI_MS_DLEN / 4] & 0x3ffff; /* bits - 1 */
    uint32_t nbytes = (dlen + 1 + 7) / 8;
    if (nbytes == 0) {
        return;
    }

    if (s->dma) {
        gpspi_do_dma_transfer(s, MIN(nbytes, GPSPI_MAX_BYTES));
        s->regs[REG_SPI_DMA_INT_RAW / 4] |= SPI_TRANS_DONE;
        gpspi_update_irq(s);
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
    if (s->dma && (addr == REG_SPI_DMA_INT_CLR || addr == REG_SPI_DMA_INT_SET)) {
        return 0; /* write-only */
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

    if (s->dma) {
        switch (addr) {
        case REG_SPI_DMA_INT_ENA:
            s->regs[addr / 4] = val;
            gpspi_update_irq(s);
            return;
        case REG_SPI_DMA_INT_CLR:
            s->regs[REG_SPI_DMA_INT_RAW / 4] &= ~(uint32_t) val;
            gpspi_update_irq(s);
            return;
        case REG_SPI_DMA_INT_SET:
            s->regs[REG_SPI_DMA_INT_RAW / 4] |= (uint32_t) val;
            gpspi_update_irq(s);
            return;
        case REG_SPI_DMA_INT_RAW:
        case REG_SPI_DMA_INT_ST:
            return; /* read-only */
        default:
            break;
        }
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
    qemu_set_irq(s->irq, 0);
}

static void gpspi_init(Object *obj)
{
    PinbenchGpspiState *s = PINBENCH_GPSPI(obj);
    memory_region_init_io(&s->iomem, obj, &gpspi_ops, s,
                          TYPE_PINBENCH_GPSPI, GPSPI_IO_SIZE);
    sysbus_init_mmio(SYS_BUS_DEVICE(obj), &s->iomem);
    sysbus_init_irq(SYS_BUS_DEVICE(obj), &s->irq);
}

static Property gpspi_props[] = {
    DEFINE_PROP_UINT8("bus-index", PinbenchGpspiState, bus_index, 0),
    DEFINE_PROP_BOOL("dma", PinbenchGpspiState, dma, false),
    DEFINE_PROP_UINT32("dram-base", PinbenchGpspiState, dram_base, 0x40800000),
    DEFINE_PROP_END_OF_LIST(),
};

static void gpspi_class_init(ObjectClass *klass, void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);
    ResettableClass *rc = RESETTABLE_CLASS(klass);
    rc->phases.hold = gpspi_reset_hold;
    dc->desc = "PinBench ESP32 GP-SPI controller (socket bridge to TS models)";
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
