/*
 * PinBench M6 — bring the GP-SPI2 / GP-SPI3 controllers onto the emulated
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

#define TYPE_PINBENCH_GPSPI "pinbench.gpspi"

/* ESP32-S3 register bases (soc/esp32s3/register/soc/reg_base.h). */
#define ESP32S3_GPSPI2_BASE 0x60024000
#define ESP32S3_GPSPI3_BASE 0x60025000

static void add_gpspi(MemoryRegion *sys_mem, hwaddr base, uint8_t bus_index)
{
    DeviceState *dev = qdev_new(TYPE_PINBENCH_GPSPI);
    qdev_prop_set_uint8(dev, "bus-index", bus_index);
    sysbus_realize_and_unref(SYS_BUS_DEVICE(dev), &error_fatal);
    MemoryRegion *mr = sysbus_mmio_get_region(SYS_BUS_DEVICE(dev), 0);
    memory_region_add_subregion_overlap(sys_mem, base, mr, 0);
}

void pinbench_esp32s3_attach(MemoryRegion *sys_mem)
{
    /* Both map to board bus index 0 — the M9's single `spi0`. MeshCore drives
     * the panel and the radio through SPI2_HOST; SPI3 exists so a probe of it
     * does not fault. */
    add_gpspi(sys_mem, ESP32S3_GPSPI2_BASE, 0);
    add_gpspi(sys_mem, ESP32S3_GPSPI3_BASE, 0);
}
