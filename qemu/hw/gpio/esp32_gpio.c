/*
 * ESP32 / ESP32-S3 GPIO emulation.
 *
 * Upstream (Espressif fork) models the strap register only — `esp32_gpio_write`
 * is `{ }`, and no output or output-enable state exists. PinBench M6 needs real
 * GPIO output: the ST7789's DC line *is* how each SPI transaction is parsed,
 * and every peripheral's chip-select is a GPIO the firmware toggles. This adds
 * the `OUT` / `OUT1` / `ENABLE` registers and their `W1TS` / `W1TC`
 * set/clear aliases, and forwards every level change to the PinBench device
 * host (no-op when PINBENCH_DEVICE_SOCKET is unset, i.e. a stock run).
 *
 * Register offsets are the ESP32-S3 GPIO block (also correct for the classic
 * ESP32 for the subset used here).
 */
#include "qemu/osdep.h"
#include "qemu/log.h"
#include "qemu/error-report.h"
#include "qapi/error.h"
#include "hw/hw.h"
#include "hw/sysbus.h"
#include "hw/registerfields.h"
#include "hw/irq.h"
#include "hw/qdev-properties.h"
#include "hw/gpio/esp32_gpio.h"
#include "hw/misc/pinbench_host.h"

#define A_GPIO_OUT           0x0004
#define A_GPIO_OUT_W1TS      0x0008
#define A_GPIO_OUT_W1TC      0x000c
#define A_GPIO_OUT1          0x0010
#define A_GPIO_OUT1_W1TS     0x0014
#define A_GPIO_OUT1_W1TC     0x0018
#define A_GPIO_ENABLE        0x0020
#define A_GPIO_ENABLE_W1TS   0x0024
#define A_GPIO_ENABLE_W1TC   0x0028
#define A_GPIO_ENABLE1       0x002c
#define A_GPIO_ENABLE1_W1TS  0x0030
#define A_GPIO_ENABLE1_W1TC  0x0034
#define A_GPIO_IN            0x003c
#define A_GPIO_IN1           0x0040

#define GPIO_BANK1_PINS 22 /* GPIO32..53 */

static void esp32_gpio_forward(Esp32GpioState *s)
{
    uint64_t now = (uint64_t) s->out | ((uint64_t) s->out1 << 32);
    uint64_t changed = now ^ s->last_out;
    if (!changed) {
        return;
    }
    PinbenchHost *host = pinbench_host_get();
    if (host) {
        for (int pin = 0; pin < 32 + GPIO_BANK1_PINS; pin++) {
            if (changed & (1ull << pin)) {
                pinbench_host_gpio(host, pin, (now >> pin) & 1);
            }
        }
    }
    s->last_out = now;
}

static uint64_t esp32_gpio_read(void *opaque, hwaddr addr, unsigned int size)
{
    Esp32GpioState *s = ESP32_GPIO(opaque);
    switch (addr) {
    case A_GPIO_STRAP:
        return s->strap_mode;
    case A_GPIO_OUT:
        return s->out;
    case A_GPIO_OUT1:
        return s->out1;
    case A_GPIO_ENABLE:
        return s->enable;
    case A_GPIO_ENABLE1:
        return s->enable1;
    case A_GPIO_IN:
        return s->out;   /* no external inputs modelled; read back the drive */
    case A_GPIO_IN1:
        return s->out1;
    default:
        return 0;
    }
}

static void esp32_gpio_write(void *opaque, hwaddr addr,
                             uint64_t value, unsigned int size)
{
    Esp32GpioState *s = ESP32_GPIO(opaque);
    uint32_t v = (uint32_t) value;

    switch (addr) {
    case A_GPIO_OUT:          s->out = v;             break;
    case A_GPIO_OUT_W1TS:     s->out |= v;            break;
    case A_GPIO_OUT_W1TC:     s->out &= ~v;           break;
    case A_GPIO_OUT1:         s->out1 = v;            break;
    case A_GPIO_OUT1_W1TS:    s->out1 |= v;           break;
    case A_GPIO_OUT1_W1TC:    s->out1 &= ~v;          break;
    case A_GPIO_ENABLE:       s->enable = v;          return;
    case A_GPIO_ENABLE_W1TS:  s->enable |= v;         return;
    case A_GPIO_ENABLE_W1TC:  s->enable &= ~v;        return;
    case A_GPIO_ENABLE1:      s->enable1 = v;         return;
    case A_GPIO_ENABLE1_W1TS: s->enable1 |= v;        return;
    case A_GPIO_ENABLE1_W1TC: s->enable1 &= ~v;       return;
    default:
        return;
    }
    esp32_gpio_forward(s);
}

static const MemoryRegionOps uart_ops = {
    .read =  esp32_gpio_read,
    .write = esp32_gpio_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
};

static void esp32_gpio_reset_hold(Object *obj, ResetType type)
{
    Esp32GpioState *s = ESP32_GPIO(obj);
    s->out = s->out1 = s->enable = s->enable1 = 0;
    s->last_out = 0;
}

static void esp32_gpio_realize(DeviceState *dev, Error **errp)
{
}

static void esp32_gpio_init(Object *obj)
{
    Esp32GpioState *s = ESP32_GPIO(obj);
    SysBusDevice *sbd = SYS_BUS_DEVICE(obj);

    object_property_set_int(obj, "strap_mode", ESP32_STRAP_MODE_FLASH_BOOT, &error_fatal);

    memory_region_init_io(&s->iomem, obj, &uart_ops, s,
                          TYPE_ESP32_GPIO, 0x1000);
    sysbus_init_mmio(sbd, &s->iomem);
    sysbus_init_irq(sbd, &s->irq);
}

static Property esp32_gpio_properties[] = {
    DEFINE_PROP_UINT32("strap_mode", Esp32GpioState, strap_mode, 0),
    DEFINE_PROP_END_OF_LIST(),
};

static void esp32_gpio_class_init(ObjectClass *klass, void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);
    ResettableClass *rc = RESETTABLE_CLASS(klass);

    rc->phases.hold = esp32_gpio_reset_hold;
    dc->realize = esp32_gpio_realize;
    device_class_set_props(dc, esp32_gpio_properties);
}

static const TypeInfo esp32_gpio_info = {
    .name = TYPE_ESP32_GPIO,
    .parent = TYPE_SYS_BUS_DEVICE,
    .instance_size = sizeof(Esp32GpioState),
    .instance_init = esp32_gpio_init,
    .class_init = esp32_gpio_class_init,
    .class_size = sizeof(Esp32GpioClass),
};

static void esp32_gpio_register_types(void)
{
    type_register_static(&esp32_gpio_info);
}

type_init(esp32_gpio_register_types)
