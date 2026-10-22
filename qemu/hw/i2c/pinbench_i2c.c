/*
 * PinBench I2C master for the emulated ESP32-C6 (I2C0 at 0x60004000), bridged
 * to the PinBench device host instead of QEMU's own i2c_bus.
 *
 * The fork's hw/i2c/esp32_i2c.c is the ESP32-classic block: its command
 * opcodes (RSTART 0, WRITE 1, READ 2, STOP 3, END 4) are not the C6's, and it
 * talks to QEMU-side I2C slaves. On the C6 the register file is the same shape
 * but the opcodes are IDF's i2c_ll.h ones:
 *
 *   WRITE 1, STOP 2, READ 3, END 4, RSTART 6
 *
 * and the peripherals (CST816S touch, QMI8658, PCF85063) are TypeScript models
 * in the device host. So this controller executes the COMD0..7 command list on
 * `CTR.TRANS_START`, synchronously:
 *
 *   - the first WRITE byte after a (re)start is the address byte; the rest of
 *     the WRITE bytes accumulate until RSTART / STOP / a READ, then go to the
 *     host as one write transaction;
 *   - a READ asks the host for that many bytes into the RX FIFO;
 *   - STOP latches TRANS_COMPLETE, END latches END_DETECT, a NACK (the host
 *     replies with an empty payload: no model at that address) latches NACK
 *     when the command checks ACK, and every executed command gets its DONE bit.
 *
 * Accumulating across END matters: IDF splits a long write over several
 * command lists with END between them, and the device must still see one
 * write. Interrupts are real (`INT_RAW/ENA/CLR/STATUS`) because IDF's
 * `i2c_master` driver is ISR-driven.
 *
 * Host framing (see src/shared/devices/protocol.ts, "I2C"): Op.Xfer with
 * bus = 0x80 | controller, select = 7-bit address | 0x8000 for a read; a write
 * carries its bytes, a read carries `len` placeholder bytes.
 */
#include "qemu/osdep.h"
#include "qemu/log.h"
#include "qemu/module.h"
#include "qemu/fifo8.h"
#include "hw/hw.h"
#include "hw/irq.h"
#include "hw/sysbus.h"
#include "hw/qdev-properties.h"
#include "qapi/error.h"
#include "hw/misc/pinbench_host.h"

#define TYPE_PINBENCH_I2C "pinbench.i2c"
#define PINBENCH_I2C(obj) OBJECT_CHECK(PinbenchI2cState, (obj), TYPE_PINBENCH_I2C)

#define I2C_IO_SIZE      0x200
#define REG_CTR          0x04
#define REG_SR           0x08
#define REG_FIFO_ST      0x14
#define REG_FIFO_CONF    0x18
#define REG_DATA         0x1c
#define REG_INT_RAW      0x20
#define REG_INT_CLR      0x24
#define REG_INT_ENA      0x28
#define REG_INT_STATUS   0x2c
#define REG_COMD0        0x58
#define REG_COMD7        0x74

#define CTR_TRANS_START  (1u << 5)
#define CTR_CONF_UPGATE  (1u << 11)
#define FIFO_CONF_RX_RST (1u << 12)
#define FIFO_CONF_TX_RST (1u << 13)

#define INT_END_DETECT   (1u << 3)
#define INT_TRANS_COMPLETE (1u << 7)
#define INT_NACK         (1u << 10)

#define CMD_BYTE_NUM(c)  ((c) & 0xff)
#define CMD_ACK_CHECK(c) (((c) >> 8) & 1)
#define CMD_OPCODE(c)    (((c) >> 11) & 0x7)
#define CMD_DONE         (1u << 31)

#define OP_WRITE   1
#define OP_STOP    2
#define OP_READ    3
#define OP_END     4
#define OP_RSTART  6

#define I2C_FIFO_LEN     32
#define I2C_CMD_COUNT    8
#define I2C_PENDING_MAX  256
#define I2C_READ_FLAG    0x8000

typedef struct PinbenchI2cState {
    SysBusDevice parent_obj;
    MemoryRegion iomem;
    qemu_irq irq;
    uint8_t controller;

    uint32_t regs[I2C_IO_SIZE / 4];
    Fifo8 tx_fifo;
    Fifo8 rx_fifo;

    /* Transaction state, kept across command lists split by END. */
    bool addressed;        /* an address byte has been sent since (re)start */
    uint8_t addr;          /* 7-bit */
    bool is_read;
    bool nacked;
    uint8_t pending[I2C_PENDING_MAX];
    uint32_t pending_len;
} PinbenchI2cState;

static void i2c_update_irq(PinbenchI2cState *s)
{
    uint32_t st = s->regs[REG_INT_RAW / 4] & s->regs[REG_INT_ENA / 4];
    s->regs[REG_INT_STATUS / 4] = st;
    qemu_set_irq(s->irq, st ? 1 : 0);
}

static uint8_t i2c_bus_id(PinbenchI2cState *s)
{
    return 0x80 | s->controller;
}

/* Send the accumulated write bytes to the host. Returns false on NACK. */
static bool i2c_flush_write(PinbenchI2cState *s)
{
    if (!s->addressed || s->is_read || s->nacked) {
        s->pending_len = 0;
        return !s->nacked;
    }
    bool ack = pinbench_host_i2c(pinbench_host_get(), i2c_bus_id(s), s->addr, false,
                                 s->pending, s->pending_len);
    s->pending_len = 0;
    if (!ack) {
        s->nacked = true;
    }
    return ack;
}

static void i2c_end_segment(PinbenchI2cState *s)
{
    i2c_flush_write(s);
    s->addressed = false;
    s->is_read = false;
    s->nacked = false;
}

static void i2c_execute(PinbenchI2cState *s)
{
    uint32_t raised = 0;
    for (int i = 0; i < I2C_CMD_COUNT; i++) {
        uint32_t *cmd = &s->regs[REG_COMD0 / 4 + i];
        uint32_t op = CMD_OPCODE(*cmd);
        uint32_t n = CMD_BYTE_NUM(*cmd);
        bool stop_here = false;

        switch (op) {
        case OP_RSTART:
            i2c_end_segment(s);
            break;
        case OP_WRITE:
            for (uint32_t b = 0; b < n && !fifo8_is_empty(&s->tx_fifo); b++) {
                uint8_t byte = fifo8_pop(&s->tx_fifo);
                if (!s->addressed) {
                    s->addressed = true;
                    s->addr = byte >> 1;
                    s->is_read = byte & 1;
                    s->nacked = false;
                    s->pending_len = 0;
                    /* An empty write probes the address (Wire's scanner). */
                    if (!s->is_read && !pinbench_host_i2c(pinbench_host_get(), i2c_bus_id(s),
                                                          s->addr, false, NULL, 0)) {
                        s->nacked = true;
                    }
                } else if (s->pending_len < I2C_PENDING_MAX) {
                    s->pending[s->pending_len++] = byte;
                }
            }
            if (s->nacked && CMD_ACK_CHECK(*cmd)) {
                raised |= INT_NACK;
                stop_here = true;
            }
            break;
        case OP_READ: {
            uint8_t buf[I2C_FIFO_LEN];
            uint32_t len = MIN(n, (uint32_t) I2C_FIFO_LEN);
            memset(buf, 0xff, sizeof(buf));
            if (s->addressed && s->is_read && !s->nacked) {
                if (!pinbench_host_i2c(pinbench_host_get(), i2c_bus_id(s), s->addr, true,
                                       buf, len)) {
                    s->nacked = true;
                    memset(buf, 0xff, sizeof(buf));
                }
            }
            for (uint32_t b = 0; b < len && !fifo8_is_full(&s->rx_fifo); b++) {
                fifo8_push(&s->rx_fifo, buf[b]);
            }
            break;
        }
        case OP_STOP:
            i2c_end_segment(s);
            raised |= INT_TRANS_COMPLETE;
            stop_here = true;
            break;
        case OP_END:
            raised |= INT_END_DETECT;
            stop_here = true;
            break;
        default:
            qemu_log_mask(LOG_GUEST_ERROR, "pinbench.i2c: unknown opcode %u in COMD%d\n", op, i);
            break;
        }
        *cmd |= CMD_DONE;
        if (stop_here) {
            break;
        }
    }
    s->regs[REG_INT_RAW / 4] |= raised;
    i2c_update_irq(s);
}

static uint32_t i2c_sr(PinbenchI2cState *s)
{
    uint32_t sr = 0;
    sr |= (fifo8_num_used(&s->rx_fifo) & 0x3f) << 8;  /* RXFIFO_CNT */
    sr |= (fifo8_num_used(&s->tx_fifo) & 0x3f) << 18; /* TXFIFO_CNT */
    return sr;                                        /* never BUS_BUSY: synchronous */
}

static uint64_t i2c_read(void *opaque, hwaddr addr, unsigned size)
{
    PinbenchI2cState *s = opaque;
    if (addr + 4 > I2C_IO_SIZE) {
        return 0;
    }
    switch (addr) {
    case REG_SR:
        return i2c_sr(s);
    case REG_DATA:
        return fifo8_is_empty(&s->rx_fifo) ? 0 : fifo8_pop(&s->rx_fifo);
    case REG_INT_CLR:
        return 0;
    default:
        return s->regs[addr / 4];
    }
}

static void i2c_write(void *opaque, hwaddr addr, uint64_t val, unsigned size)
{
    PinbenchI2cState *s = opaque;
    if (addr + 4 > I2C_IO_SIZE) {
        return;
    }
    switch (addr) {
    case REG_CTR:
        s->regs[addr / 4] = val & ~(CTR_TRANS_START | CTR_CONF_UPGATE);
        if (val & CTR_TRANS_START) {
            i2c_execute(s);
        }
        return;
    case REG_FIFO_CONF:
        if (val & FIFO_CONF_RX_RST) {
            fifo8_reset(&s->rx_fifo);
        }
        if (val & FIFO_CONF_TX_RST) {
            fifo8_reset(&s->tx_fifo);
        }
        s->regs[addr / 4] = val;
        return;
    case REG_DATA:
        if (!fifo8_is_full(&s->tx_fifo)) {
            fifo8_push(&s->tx_fifo, val & 0xff);
        }
        return;
    case REG_INT_CLR:
        s->regs[REG_INT_RAW / 4] &= ~(uint32_t) val;
        i2c_update_irq(s);
        return;
    case REG_INT_ENA:
        s->regs[addr / 4] = val;
        i2c_update_irq(s);
        return;
    case REG_INT_RAW:
    case REG_INT_STATUS:
    case REG_SR:
        return;
    default:
        s->regs[addr / 4] = val;
        return;
    }
}

static const MemoryRegionOps i2c_ops = {
    .read = i2c_read,
    .write = i2c_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid.min_access_size = 1,
    .valid.max_access_size = 4,
};

static void i2c_reset_hold(Object *obj, ResetType type)
{
    PinbenchI2cState *s = PINBENCH_I2C(obj);
    memset(s->regs, 0, sizeof(s->regs));
    fifo8_reset(&s->tx_fifo);
    fifo8_reset(&s->rx_fifo);
    s->addressed = s->is_read = s->nacked = false;
    s->pending_len = 0;
    qemu_set_irq(s->irq, 0);
}

static void i2c_init(Object *obj)
{
    PinbenchI2cState *s = PINBENCH_I2C(obj);
    memory_region_init_io(&s->iomem, obj, &i2c_ops, s, TYPE_PINBENCH_I2C, I2C_IO_SIZE);
    sysbus_init_mmio(SYS_BUS_DEVICE(obj), &s->iomem);
    sysbus_init_irq(SYS_BUS_DEVICE(obj), &s->irq);
    fifo8_create(&s->tx_fifo, I2C_FIFO_LEN);
    fifo8_create(&s->rx_fifo, I2C_FIFO_LEN);
}

static Property i2c_props[] = {
    DEFINE_PROP_UINT8("controller", PinbenchI2cState, controller, 0),
    DEFINE_PROP_END_OF_LIST(),
};

static void i2c_class_init(ObjectClass *klass, void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);
    ResettableClass *rc = RESETTABLE_CLASS(klass);
    rc->phases.hold = i2c_reset_hold;
    dc->desc = "PinBench ESP32-C6 I2C master (socket bridge to TS models)";
    device_class_set_props(dc, i2c_props);
}

static const TypeInfo i2c_info = {
    .name = TYPE_PINBENCH_I2C,
    .parent = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(PinbenchI2cState),
    .instance_init = i2c_init,
    .class_init = i2c_class_init,
};

static void i2c_register_types(void)
{
    type_register_static(&i2c_info);
}

type_init(i2c_register_types)
