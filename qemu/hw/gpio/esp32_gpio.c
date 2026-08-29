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
 *
 * PinBench M7 adds the reverse direction: a GPIO_IN / GPIO_IN1 read of a pin
 * in the device host's input mask (LR1110 BUSY / DIO9, later GNSS PPS,
 * KEY_INT) is routed to the host, which answers with the level a TS device
 * model is driving. Pins outside the mask still read back the guest's own
 * output drive, as before.
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

/*
 * Overlay host-driven input levels onto `base` for the pins of one bank that
 * are set in the device host's input mask. `bank_lo` is the first pin number
 * of the bank (0 or 32); the returned value is bank-relative like the register.
 */
static uint32_t esp32_gpio_apply_host_inputs(uint32_t base, int bank_lo)
{
    PinbenchHost *host = pinbench_host_get();
    uint64_t mask = pinbench_host_input_mask(host);
    if (!mask) {
        return base;
    }
    for (int pin = bank_lo; pin < bank_lo + 32; pin++) {
        if (mask & (1ull << pin)) {
            int bit = pin - bank_lo;
            if (pinbench_host_gpio_read(host, pin)) {
                base |= (1u << bit);
            } else {
                base &= ~(1u << bit);
            }
        }
    }
    return base;
}

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

/*
 * Forward the current OUT level of specific pins to the device host, even when
 * that level is unchanged since the last forward. Used when a pin's output
 * driver is switched on (GPIO_ENABLE 0->1, i.e. `pinMode(pin, OUTPUT)`): the
 * SoC now actively drives the line, which is a real electrical event the device
 * model must see even if the level is still 0. Without this, a guest that does
 * `pinMode(RST, OUTPUT); digitalWrite(RST, LOW)` over a reset-0 OUT register
 * produces no frame at all, and a model that probes that line (the e-ink
 * `detectEInk()` reset-polarity test) reads a stale idle level and mis-detects.
 */
static void esp32_gpio_forward_enabled(Esp32GpioState *s, uint64_t pins)
{
    if (!pins) {
        return;
    }
    uint64_t now = (uint64_t) s->out | ((uint64_t) s->out1 << 32);
    PinbenchHost *host = pinbench_host_get();
    if (host) {
        for (int pin = 0; pin < 32 + GPIO_BANK1_PINS; pin++) {
            if (pins & (1ull << pin)) {
                pinbench_host_gpio(host, pin, (now >> pin) & 1);
            }
        }
    }
    /* Keep last_out coherent for these pins so a later real OUT write still
     * diffs correctly (and isn't double-emitted). */
    s->last_out = (s->last_out & ~pins) | (now & pins);
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
        /* Host-driven inputs override the drive-back for masked pins (M7). */
        return esp32_gpio_apply_host_inputs(s->out, 0);
    case A_GPIO_IN1:
        return esp32_gpio_apply_host_inputs(s->out1, 32);
    default:
        return 0;
    }
}

static void esp32_gpio_write(void *opaque, hwaddr addr,
                             uint64_t value, unsigned int size)
{
    Esp32GpioState *s = ESP32_GPIO(opaque);
    uint32_t v = (uint32_t) value;
    uint64_t old_enable = (uint64_t) s->enable | ((uint64_t) s->enable1 << 32);
    bool is_enable = true;

    switch (addr) {
    case A_GPIO_OUT:          s->out = v;             is_enable = false; break;
    case A_GPIO_OUT_W1TS:     s->out |= v;            is_enable = false; break;
    case A_GPIO_OUT_W1TC:     s->out &= ~v;           is_enable = false; break;
    case A_GPIO_OUT1:         s->out1 = v;            is_enable = false; break;
    case A_GPIO_OUT1_W1TS:    s->out1 |= v;           is_enable = false; break;
    case A_GPIO_OUT1_W1TC:    s->out1 &= ~v;          is_enable = false; break;
    case A_GPIO_ENABLE:       s->enable = v;          break;
    case A_GPIO_ENABLE_W1TS:  s->enable |= v;         break;
    case A_GPIO_ENABLE_W1TC:  s->enable &= ~v;        break;
    case A_GPIO_ENABLE1:      s->enable1 = v;         break;
    case A_GPIO_ENABLE1_W1TS: s->enable1 |= v;        break;
    case A_GPIO_ENABLE1_W1TC: s->enable1 &= ~v;       break;
    default:
        return;
    }

    if (is_enable) {
        uint64_t new_enable = (uint64_t) s->enable | ((uint64_t) s->enable1 << 32);
        esp32_gpio_forward_enabled(s, new_enable & ~old_enable);
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
