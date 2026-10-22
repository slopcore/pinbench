#include "GC9A01.h"

#include <Arduino.h>
#include "driver/spi_master.h"
#include "esp_err.h"
#include "esp_lcd_io_spi.h"
#include "esp_lcd_panel_io.h"

namespace {

constexpr int LCD_CS = 10;
constexpr int LCD_SCLK = 11;
constexpr int LCD_DC = 19;
constexpr int LCD_MOSI = 21;
constexpr int LCD_RST = 20;
constexpr int LCD_BL = 7;
constexpr int LCD_PIXEL_CLOCK_HZ = 80 * 1000 * 1000;

esp_lcd_panel_io_handle_t lcd_io = nullptr;
lv_disp_drv_t *lcd_flushing_disp_drv = nullptr;

bool lcd_color_transfer_done(esp_lcd_panel_io_handle_t panel_io,
                             esp_lcd_panel_io_event_data_t *edata,
                             void *user_ctx)
{
    (void)panel_io;
    (void)edata;
    (void)user_ctx;

    if (lcd_flushing_disp_drv != nullptr) {
        lv_disp_flush_ready(lcd_flushing_disp_drv);
    }
    return false;
}

void lcd_cmd(uint8_t cmd, const uint8_t *data = nullptr, size_t data_len = 0)
{
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(lcd_io, cmd, data, data_len));
}

void lcd_cmd1(uint8_t cmd, uint8_t a)
{
    const uint8_t data[] = {a};
    lcd_cmd(cmd, data, sizeof(data));
}

void lcd_cmd2(uint8_t cmd, uint8_t a, uint8_t b)
{
    const uint8_t data[] = {a, b};
    lcd_cmd(cmd, data, sizeof(data));
}

void lcd_cmd3(uint8_t cmd, uint8_t a, uint8_t b, uint8_t c)
{
    const uint8_t data[] = {a, b, c};
    lcd_cmd(cmd, data, sizeof(data));
}

void lcd_cmd4(uint8_t cmd, uint8_t a, uint8_t b, uint8_t c, uint8_t d)
{
    const uint8_t data[] = {a, b, c, d};
    lcd_cmd(cmd, data, sizeof(data));
}

void lcd_cmd6(uint8_t cmd, uint8_t a, uint8_t b, uint8_t c, uint8_t d, uint8_t e, uint8_t f)
{
    const uint8_t data[] = {a, b, c, d, e, f};
    lcd_cmd(cmd, data, sizeof(data));
}

void lcd_cmd7(uint8_t cmd, uint8_t a, uint8_t b, uint8_t c, uint8_t d, uint8_t e, uint8_t f, uint8_t g)
{
    const uint8_t data[] = {a, b, c, d, e, f, g};
    lcd_cmd(cmd, data, sizeof(data));
}

void lcd_cmd9(uint8_t cmd, uint8_t a, uint8_t b, uint8_t c, uint8_t d, uint8_t e,
              uint8_t f, uint8_t g, uint8_t h, uint8_t i)
{
    const uint8_t data[] = {a, b, c, d, e, f, g, h, i};
    lcd_cmd(cmd, data, sizeof(data));
}

void lcd_cmd10(uint8_t cmd, uint8_t a, uint8_t b, uint8_t c, uint8_t d, uint8_t e,
               uint8_t f, uint8_t g, uint8_t h, uint8_t i, uint8_t j)
{
    const uint8_t data[] = {a, b, c, d, e, f, g, h, i, j};
    lcd_cmd(cmd, data, sizeof(data));
}

void lcd_cmd12(uint8_t cmd, uint8_t a, uint8_t b, uint8_t c, uint8_t d, uint8_t e,
               uint8_t f, uint8_t g, uint8_t h, uint8_t i, uint8_t j, uint8_t k, uint8_t l)
{
    const uint8_t data[] = {a, b, c, d, e, f, g, h, i, j, k, l};
    lcd_cmd(cmd, data, sizeof(data));
}

void lcd_reset()
{
    pinMode(LCD_RST, OUTPUT);
    digitalWrite(LCD_RST, HIGH);
    // GC9A01 reset timing requires millisecond-scale waits during startup.
    delay(200);
    digitalWrite(LCD_RST, LOW);
    delay(200);
    digitalWrite(LCD_RST, HIGH);
    delay(200);
}

void lcd_panel_init()
{
    lcd_cmd(0xEF);
    lcd_cmd1(0xEB, 0x14);
    lcd_cmd(0xFE);
    lcd_cmd(0xEF);
    lcd_cmd1(0xEB, 0x14);
    lcd_cmd1(0x84, 0x40);
    lcd_cmd1(0x85, 0xFF);
    lcd_cmd1(0x86, 0xFF);
    lcd_cmd1(0x87, 0xFF);
    lcd_cmd1(0x88, 0x0A);
    lcd_cmd1(0x89, 0x21);
    lcd_cmd1(0x8A, 0x00);
    lcd_cmd1(0x8B, 0x80);
    lcd_cmd1(0x8C, 0x01);
    lcd_cmd1(0x8D, 0x01);
    lcd_cmd1(0x8E, 0xFF);
    lcd_cmd1(0x8F, 0xFF);
    lcd_cmd2(0xB6, 0x00, 0x20);
    lcd_cmd1(0x36, 0x08);
    lcd_cmd1(0x3A, 0x05);
    lcd_cmd4(0x90, 0x08, 0x08, 0x08, 0x08);
    lcd_cmd1(0xBD, 0x06);
    lcd_cmd1(0xBC, 0x00);
    lcd_cmd3(0xFF, 0x60, 0x01, 0x04);
    lcd_cmd1(0xC3, 0x13);
    lcd_cmd1(0xC4, 0x13);
    lcd_cmd1(0xC9, 0x22);
    lcd_cmd1(0xBE, 0x11);
    lcd_cmd2(0xE1, 0x10, 0x0E);
    lcd_cmd3(0xDF, 0x21, 0x0C, 0x02);
    lcd_cmd6(0xF0, 0x45, 0x09, 0x08, 0x08, 0x26, 0x2A);
    lcd_cmd6(0xF1, 0x43, 0x70, 0x72, 0x36, 0x37, 0x6F);
    lcd_cmd6(0xF2, 0x45, 0x09, 0x08, 0x08, 0x26, 0x2A);
    lcd_cmd6(0xF3, 0x43, 0x70, 0x72, 0x36, 0x37, 0x6F);
    lcd_cmd2(0xED, 0x1B, 0x0B);
    lcd_cmd1(0xAE, 0x77);
    lcd_cmd1(0xCD, 0x63);
    lcd_cmd9(0x70, 0x07, 0x07, 0x04, 0x0E, 0x0F, 0x09, 0x07, 0x08, 0x03);
    lcd_cmd1(0xE8, 0x34);
    lcd_cmd12(0x62, 0x18, 0x0D, 0x71, 0xED, 0x70, 0x70, 0x18, 0x0F, 0x71, 0xEF, 0x70, 0x70);
    lcd_cmd12(0x63, 0x18, 0x11, 0x71, 0xF1, 0x70, 0x70, 0x18, 0x13, 0x71, 0xF3, 0x70, 0x70);
    lcd_cmd7(0x64, 0x28, 0x29, 0xF1, 0x01, 0xF1, 0x00, 0x07);
    lcd_cmd10(0x66, 0x3C, 0x00, 0xCD, 0x67, 0x45, 0x45, 0x10, 0x00, 0x00, 0x00);
    lcd_cmd10(0x67, 0x00, 0x3C, 0x00, 0x00, 0x00, 0x01, 0x54, 0x10, 0x32, 0x98);
    lcd_cmd7(0x74, 0x10, 0x85, 0x80, 0x00, 0x00, 0x4E, 0x00);
    lcd_cmd2(0x98, 0x3E, 0x07);
    lcd_cmd(0x35);
    lcd_cmd(0x21);
    lcd_cmd(0x11);
    delay(120);
    lcd_cmd(0x29);
    delay(20);
}

#if (LV_COLOR_16_SWAP == 0)
void lcd_swap_rgb565_bytes(lv_color_t *color, uint32_t pixel_count)
{
    uint16_t *pixel = (uint16_t *)color;
    while (pixel_count--) {
        *pixel = (*pixel << 8) | (*pixel >> 8);
        pixel++;
    }
}
#endif

} // namespace

void lcd_init()
{
    lcd_reset();

    spi_bus_config_t buscfg = {};
    buscfg.sclk_io_num = LCD_SCLK;
    buscfg.mosi_io_num = LCD_MOSI;
    buscfg.miso_io_num = -1;
    buscfg.quadwp_io_num = -1;
    buscfg.quadhd_io_num = -1;
    buscfg.max_transfer_sz = LCD_WIDTH * LCD_HEIGHT * sizeof(lv_color_t);
    ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &buscfg, SPI_DMA_CH_AUTO));

    esp_lcd_panel_io_spi_config_t io_config = {};
    io_config.cs_gpio_num = LCD_CS;
    io_config.dc_gpio_num = LCD_DC;
    io_config.spi_mode = 0;
    io_config.pclk_hz = LCD_PIXEL_CLOCK_HZ;
    io_config.trans_queue_depth = 10;
    io_config.on_color_trans_done = lcd_color_transfer_done;
    io_config.lcd_cmd_bits = 8;
    io_config.lcd_param_bits = 8;
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)SPI2_HOST, &io_config, &lcd_io));

    lcd_panel_init();
}

void lcd_backlight_on()
{
    pinMode(LCD_BL, OUTPUT);
    digitalWrite(LCD_BL, HIGH);
}

void lcd_flush(lv_disp_drv_t *disp_drv, const lv_area_t *area, lv_color_t *color_p)
{
    if (area->x1 < 0 || area->y1 < 0 || area->x2 >= LCD_WIDTH || area->y2 >= LCD_HEIGHT) {
        lv_disp_flush_ready(disp_drv);
        return;
    }

    const uint16_t x1 = area->x1;
    const uint16_t x2 = area->x2;
    const uint16_t y1 = area->y1;
    const uint16_t y2 = area->y2;
    const uint32_t w = x2 - x1 + 1;
    const uint32_t h = y2 - y1 + 1;

    const uint8_t caset[] = {
        (uint8_t)(x1 >> 8), (uint8_t)(x1 & 0xFF),
        (uint8_t)(x2 >> 8), (uint8_t)(x2 & 0xFF)
    };
    const uint8_t raset[] = {
        (uint8_t)(y1 >> 8), (uint8_t)(y1 & 0xFF),
        (uint8_t)(y2 >> 8), (uint8_t)(y2 & 0xFF)
    };

    lcd_flushing_disp_drv = disp_drv;
    esp_err_t ret = esp_lcd_panel_io_tx_param(lcd_io, 0x2A, caset, sizeof(caset));
    if (ret == ESP_OK) {
        ret = esp_lcd_panel_io_tx_param(lcd_io, 0x2B, raset, sizeof(raset));
    }
    if (ret == ESP_OK) {
#if (LV_COLOR_16_SWAP == 0)
        lcd_swap_rgb565_bytes(color_p, w * h);
#endif
        ret = esp_lcd_panel_io_tx_color(lcd_io, 0x2C, color_p, w * h * sizeof(lv_color_t));
    }
    if (ret != ESP_OK) {
        lv_disp_flush_ready(disp_drv);
    }
}
