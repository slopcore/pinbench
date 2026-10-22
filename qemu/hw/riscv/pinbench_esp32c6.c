/*
 * PinBench — bring GP-SPI2 and I2C0 onto the emulated ESP32-C6 and route the
 * GPIO block's interrupt. Two lines in hw/riscv/esp32c6.c (an include and a call to
 * pinbench_esp32c6_attach) are all the change to the upstream machine file;
 * everything else lives here, as for the S3 (hw/xtensa/pinbench_esp32s3.c).
 */
#include "qemu/osdep.h"
#include "qapi/error.h"
#include "hw/sysbus.h"
#include "hw/qdev-properties.h"
#include "exec/address-spaces.h"
#include "hw/misc/pinbench_host.h"

#define TYPE_PINBENCH_GPSPI "pinbench.gpspi"
#define TYPE_PINBENCH_I2C   "pinbench.i2c"

/* ESP32-C6 register base and interrupt sources (soc/esp32c6 reg_base.h,
 * interrupts.h; the source numbers match the fork's esp32c6_reg.h). */
#define ESP32C6_GPSPI2_BASE       0x60081000
#define ESP32C6_I2C0_BASE         0x60004000
#define ESP32C6_SRAM_BASE         0x40800000
#define ESP32C6_GPIO_INTR_SOURCE  30
#define ESP32C6_GSPI2_INTR_SOURCE 72
#define ESP32C6_I2C0_INTR_SOURCE  50

void pinbench_esp32c6_attach(MemoryRegion *sys_mem, DeviceState *intmatrix,
                             SysBusDevice *gpio)
{
    /* Route the GPIO block's interrupt to the matrix so a host-driven input
     * edge (touch INT, IMU INT) reaches guest ISRs — as on the S3. */
    sysbus_connect_irq(gpio, 0, qdev_get_gpio_in(intmatrix, ESP32C6_GPIO_INTR_SOURCE));

    /* GP-SPI2: the GC9A01 panel and the TF card. IDF's spi_master drives it
     * through GDMA and the TRANS_DONE interrupt, hence `dma`. Priority 1 so
     * it sits above the machine's "esp32c6.peripherals" unimplemented
     * catch-all. */
    DeviceState *dev = qdev_new(TYPE_PINBENCH_GPSPI);
    qdev_prop_set_uint8(dev, "bus-index", 0);
    qdev_prop_set_bit(dev, "dma", true);
    qdev_prop_set_uint32(dev, "dram-base", ESP32C6_SRAM_BASE);
    sysbus_realize_and_unref(SYS_BUS_DEVICE(dev), &error_fatal);
    memory_region_add_subregion_overlap(sys_mem, ESP32C6_GPSPI2_BASE,
                                        sysbus_mmio_get_region(SYS_BUS_DEVICE(dev), 0), 1);
    sysbus_connect_irq(SYS_BUS_DEVICE(dev), 0,
                       qdev_get_gpio_in(intmatrix, ESP32C6_GSPI2_INTR_SOURCE));

    /* I2C0: the CST816S touch, QMI8658 IMU and PCF85063 RTC, as host models.
     * Bus 0x80 | 0 = the board's first I2C bus. */
    DeviceState *i2c = qdev_new(TYPE_PINBENCH_I2C);
    qdev_prop_set_uint8(i2c, "controller", 0);
    sysbus_realize_and_unref(SYS_BUS_DEVICE(i2c), &error_fatal);
    memory_region_add_subregion_overlap(sys_mem, ESP32C6_I2C0_BASE,
                                        sysbus_mmio_get_region(SYS_BUS_DEVICE(i2c), 0), 1);
    sysbus_connect_irq(SYS_BUS_DEVICE(i2c), 0,
                       qdev_get_gpio_in(intmatrix, ESP32C6_I2C0_INTR_SOURCE));
}
