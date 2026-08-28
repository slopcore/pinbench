#pragma once

#include "hw/sysbus.h"
#include "hw/hw.h"
#include "hw/registerfields.h"

#define TYPE_ESP32_GPIO "esp32.gpio"
#define ESP32_GPIO(obj)             OBJECT_CHECK(Esp32GpioState, (obj), TYPE_ESP32_GPIO)
#define ESP32_GPIO_GET_CLASS(obj)   OBJECT_GET_CLASS(Esp32GpioClass, obj, TYPE_ESP32_GPIO)
#define ESP32_GPIO_CLASS(klass)     OBJECT_CLASS_CHECK(Esp32GpioClass, klass, TYPE_ESP32_GPIO)

REG32(GPIO_STRAP, 0x0038)

#define ESP32_STRAP_MODE_FLASH_BOOT 0x12
#define ESP32_STRAP_MODE_UART_BOOT  0x0f

typedef struct Esp32GpioState {
    SysBusDevice parent_obj;

    MemoryRegion iomem;
    qemu_irq irq;
    uint32_t strap_mode;

    /*
     * PinBench (M6): output and output-enable state for GPIO0..53, split into
     * the two hardware banks. `esp32_gpio_write` was an empty stub in the
     * Espressif fork — no output modelled at all — so nothing on a plain GPIO
     * (the ST7789's DC/RST/BL, every chip-select) could be driven. These hold
     * the state and `last_out` lets the observer emit only real edges.
     */
    uint32_t out;        /* GPIO0..31  */
    uint32_t out1;       /* GPIO32..53 (bits 0..21) */
    uint32_t enable;     /* GPIO0..31  */
    uint32_t enable1;    /* GPIO32..53 */
    uint64_t last_out;   /* combined 54-bit level last forwarded to the host */
} Esp32GpioState;

typedef struct Esp32GpioClass {
    SysBusDeviceClass parent_class;
} Esp32GpioClass;
