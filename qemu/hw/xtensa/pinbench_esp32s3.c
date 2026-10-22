/*
 * PinBench M6 — bring the GP-SPI2 / GP-SPI3 controllers and SENS/ADC peripherals onto the emulated
 * ESP32-S3. Two lines in hw/xtensa/esp32s3.c (an include and a call to
 * pinbench_esp32s3_attach) are all the change to the upstream machine file;
 * everything else lives here so a rebase onto a newer espressif/qemu is cheap.
 */
#include "qemu/osdep.h"
#include "qapi/error.h"
#include "hw/sysbus.h"
#include "hw/qdev-properties.h"
#include "exec/address-spaces.h"
#include "hw/misc/pinbench_host.h"

#define TYPE_PINBENCH_GPSPI   "pinbench.gpspi"
#define TYPE_PINBENCH_SENS    "pinbench.sens"
#define TYPE_PINBENCH_SARADC  "pinbench.saradc"

#define PINBENCH_SENS(obj)   OBJECT_CHECK(PinbenchSensState, (obj), TYPE_PINBENCH_SENS)
#define PINBENCH_SARADC(obj) OBJECT_CHECK(PinbenchSaradcState, (obj), TYPE_PINBENCH_SARADC)

/* ESP32-S3 register bases (soc/esp32s3/register/soc/reg_base.h). */
#define ESP32S3_GPSPI2_BASE 0x60024000
#define ESP32S3_GPSPI3_BASE 0x60025000
#define ESP32S3_SENS_BASE   0x60008800
#define ESP32S3_SARADC_BASE 0x60040000

#define SENS_SIZE           0x800
#define SARADC_SIZE         0x1000

typedef struct PinbenchSensState {
    SysBusDevice parent_obj;
    MemoryRegion iomem;
    uint32_t regs[SENS_SIZE / 4];
} PinbenchSensState;

typedef struct PinbenchSaradcState {
    SysBusDevice parent_obj;
    MemoryRegion iomem;
    uint32_t regs[SARADC_SIZE / 4];
} PinbenchSaradcState;

static uint64_t pinbench_sens_read(void *opaque, hwaddr addr, unsigned int size)
{
    PinbenchSensState *s = opaque;
    hwaddr sens_reg = addr & ~3ull;
    uint32_t shift = (addr & 3) * 8;
    uint32_t idx = (sens_reg & (SENS_SIZE - 1)) >> 2;
    uint32_t val = s->regs[idx];

    switch (sens_reg) {
    case 0x0c: /* SENS_SAR_MEAS1_CTRL2_REG */
    case 0x30: /* SENS_SAR_MEAS2_CTRL2_REG */
        /* Bit 16 is DONE_SAR (1 = conversion done).
         * Bits 0..15 are DATA_SAR (return ~2800 for ~3.9V battery reading). */
        val |= (1u << 16);
        if ((val & 0xffff) == 0) {
            val |= 2800;
        }
        break;
    case 0x3c: /* SENS_SAR_SLAVE_ADDR1_REG: meas_status (bits 22..29) must be 0 */
    case 0x40:
        val &= ~(0xFFu << 22);
        break;
    case 0x48: /* SENS_SAR_TSENS_CTRL_REG */
        /* Bit 8 is tsens_ready (1 = ready), bits 0..7 is tsens_out (e.g. 128 = ~25C) */
        val |= (1u << 8) | 128;
        break;
    default:
        break;
    }

    return (val >> shift) & ((1ull << (size * 8)) - 1);
}

static void pinbench_sens_write(void *opaque, hwaddr addr, uint64_t value, unsigned int size)
{
    PinbenchSensState *s = opaque;
    hwaddr sens_reg = addr & ~3ull;
    uint32_t shift = (addr & 3) * 8;
    uint32_t idx = (sens_reg & (SENS_SIZE - 1)) >> 2;
    uint32_t mask = ((1ull << (size * 8)) - 1) << shift;
    s->regs[idx] = (s->regs[idx] & ~mask) | (((uint32_t)value << shift) & mask);
}

static const MemoryRegionOps pinbench_sens_ops = {
    .read = pinbench_sens_read,
    .write = pinbench_sens_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid = {
        .min_access_size = 1,
        .max_access_size = 4,
    },
};

static void sens_init(Object *obj)
{
    PinbenchSensState *s = PINBENCH_SENS(obj);
    memory_region_init_io(&s->iomem, obj, &pinbench_sens_ops, s,
                          TYPE_PINBENCH_SENS, SENS_SIZE);
    sysbus_init_mmio(SYS_BUS_DEVICE(obj), &s->iomem);
}

static const TypeInfo sens_info = {
    .name = TYPE_PINBENCH_SENS,
    .parent = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(PinbenchSensState),
    .instance_init = sens_init,
};

static uint64_t pinbench_saradc_read(void *opaque, hwaddr addr, unsigned int size)
{
    PinbenchSaradcState *s = opaque;
    hwaddr adc_reg = addr & ~3ull;
    uint32_t shift = (addr & 3) * 8;
    uint32_t idx = (adc_reg & (SARADC_SIZE - 1)) >> 2;
    uint32_t val = s->regs[idx];
    switch (adc_reg) {
    case 0x3c: /* APB_SARADC1_DATA_STATUS_REG */
    case 0x40: /* APB_SARADC2_DATA_STATUS_REG */
        val = 2800;
        break;
    default:
        break;
    }
    return (val >> shift) & ((1ull << (size * 8)) - 1);
}

static void pinbench_saradc_write(void *opaque, hwaddr addr, uint64_t value, unsigned int size)
{
    PinbenchSaradcState *s = opaque;
    hwaddr adc_reg = addr & ~3ull;
    uint32_t shift = (addr & 3) * 8;
    uint32_t idx = (adc_reg & (SARADC_SIZE - 1)) >> 2;
    uint32_t mask = ((1ull << (size * 8)) - 1) << shift;
    s->regs[idx] = (s->regs[idx] & ~mask) | (((uint32_t)value << shift) & mask);
}

static const MemoryRegionOps pinbench_saradc_ops = {
    .read = pinbench_saradc_read,
    .write = pinbench_saradc_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid = {
        .min_access_size = 1,
        .max_access_size = 4,
    },
};

static void saradc_init(Object *obj)
{
    PinbenchSaradcState *s = PINBENCH_SARADC(obj);
    memory_region_init_io(&s->iomem, obj, &pinbench_saradc_ops, s,
                          TYPE_PINBENCH_SARADC, SARADC_SIZE);
    sysbus_init_mmio(SYS_BUS_DEVICE(obj), &s->iomem);
}

static const TypeInfo saradc_info = {
    .name = TYPE_PINBENCH_SARADC,
    .parent = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(PinbenchSaradcState),
    .instance_init = saradc_init,
};

static void add_gpspi(MemoryRegion *sys_mem, hwaddr base, uint8_t bus_index)
{
    DeviceState *dev = qdev_new(TYPE_PINBENCH_GPSPI);
    qdev_prop_set_uint8(dev, "bus-index", bus_index);
    sysbus_realize_and_unref(SYS_BUS_DEVICE(dev), &error_fatal);
    MemoryRegion *mr = sysbus_mmio_get_region(SYS_BUS_DEVICE(dev), 0);
    memory_region_add_subregion_overlap(sys_mem, base, mr, 0);
}

static void add_sens(MemoryRegion *sys_mem, hwaddr base)
{
    DeviceState *dev = qdev_new(TYPE_PINBENCH_SENS);
    sysbus_realize_and_unref(SYS_BUS_DEVICE(dev), &error_fatal);
    MemoryRegion *mr = sysbus_mmio_get_region(SYS_BUS_DEVICE(dev), 0);
    memory_region_add_subregion_overlap(sys_mem, base, mr, 1);
}

static void add_saradc(MemoryRegion *sys_mem, hwaddr base)
{
    DeviceState *dev = qdev_new(TYPE_PINBENCH_SARADC);
    sysbus_realize_and_unref(SYS_BUS_DEVICE(dev), &error_fatal);
    MemoryRegion *mr = sysbus_mmio_get_region(SYS_BUS_DEVICE(dev), 0);
    memory_region_add_subregion_overlap(sys_mem, base, mr, 1);
}

void pinbench_esp32s3_attach(MemoryRegion *sys_mem)
{
    /* Both map to board bus index 0 — the M9's single `spi0`. MeshCore drives
     * the panel and the radio through SPI2_HOST; SPI3 exists so a probe of it
     * does not fault. */
    add_gpspi(sys_mem, ESP32S3_GPSPI2_BASE, 0);
    add_gpspi(sys_mem, ESP32S3_GPSPI3_BASE, 0);

    /* SENS (RTC_CNTL SAR ADC & TSENS) and APB_SARADC peripherals */
    add_sens(sys_mem, ESP32S3_SENS_BASE);
    add_saradc(sys_mem, ESP32S3_SARADC_BASE);
}

static void pinbench_sens_register_types(void)
{
    type_register_static(&sens_info);
    type_register_static(&saradc_info);
}

type_init(pinbench_sens_register_types)
