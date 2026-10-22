// Waveshare ESP32-C6-Touch-LCD-1.28 fixture. The lcd_* functions are
// Waveshare's GC9A01.cpp (Arduino-v3.2.1 LVGL demo) with LVGL removed, and
// CST816S.{h,cpp} is the touch driver from the same demo, unmodified; see
// platformio.ini.

#include <Arduino.h>
#include "driver/spi_master.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_lcd_io_spi.h"
#include "esp_lcd_panel_io.h"
#include "CST816S.h"

namespace {

constexpr uint16_t LCD_WIDTH = 240;
constexpr uint16_t LCD_HEIGHT = 240;

constexpr int LCD_CS = 10;
constexpr int LCD_SCLK = 11;
constexpr int LCD_DC = 19;
constexpr int LCD_MOSI = 21;
constexpr int LCD_RST = 20;
constexpr int LCD_BL = 7;
constexpr int LCD_PIXEL_CLOCK_HZ = 80 * 1000 * 1000;

// Rows per tx_color, as an LVGL partial draw buffer would send.
constexpr uint16_t BAND_ROWS = 24;

esp_lcd_panel_io_handle_t lcd_io = nullptr;
volatile uint32_t color_done = 0;

bool lcd_color_transfer_done(esp_lcd_panel_io_handle_t panel_io,
                             esp_lcd_panel_io_event_data_t *edata,
                             void *user_ctx)
{
    (void)panel_io;
    (void)edata;
    (void)user_ctx;
    color_done = color_done + 1;
    return false;
}

void lcd_cmd(uint8_t cmd, const uint8_t *data = nullptr, size_t data_len = 0)
{
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(lcd_io, cmd, data, data_len));
}

template <typename... Bytes>
void lcd_cmdn(uint8_t cmd, Bytes... bytes)
{
    const uint8_t data[] = {static_cast<uint8_t>(bytes)...};
    lcd_cmd(cmd, data, sizeof(data));
}

void lcd_reset()
{
    pinMode(LCD_RST, OUTPUT);
    digitalWrite(LCD_RST, HIGH);
    delay(200);
    digitalWrite(LCD_RST, LOW);
    delay(200);
    digitalWrite(LCD_RST, HIGH);
    delay(200);
}

void lcd_panel_init()
{
    lcd_cmd(0xEF);
    lcd_cmdn(0xEB, 0x14);
    lcd_cmd(0xFE);
    lcd_cmd(0xEF);
    lcd_cmdn(0xEB, 0x14);
    lcd_cmdn(0x84, 0x40);
    lcd_cmdn(0x85, 0xFF);
    lcd_cmdn(0x86, 0xFF);
    lcd_cmdn(0x87, 0xFF);
    lcd_cmdn(0x88, 0x0A);
    lcd_cmdn(0x89, 0x21);
    lcd_cmdn(0x8A, 0x00);
    lcd_cmdn(0x8B, 0x80);
    lcd_cmdn(0x8C, 0x01);
    lcd_cmdn(0x8D, 0x01);
    lcd_cmdn(0x8E, 0xFF);
    lcd_cmdn(0x8F, 0xFF);
    lcd_cmdn(0xB6, 0x00, 0x20);
    lcd_cmdn(0x36, 0x08);
    lcd_cmdn(0x3A, 0x05);
    lcd_cmdn(0x90, 0x08, 0x08, 0x08, 0x08);
    lcd_cmdn(0xBD, 0x06);
    lcd_cmdn(0xBC, 0x00);
    lcd_cmdn(0xFF, 0x60, 0x01, 0x04);
    lcd_cmdn(0xC3, 0x13);
    lcd_cmdn(0xC4, 0x13);
    lcd_cmdn(0xC9, 0x22);
    lcd_cmdn(0xBE, 0x11);
    lcd_cmdn(0xE1, 0x10, 0x0E);
    lcd_cmdn(0xDF, 0x21, 0x0C, 0x02);
    lcd_cmdn(0xF0, 0x45, 0x09, 0x08, 0x08, 0x26, 0x2A);
    lcd_cmdn(0xF1, 0x43, 0x70, 0x72, 0x36, 0x37, 0x6F);
    lcd_cmdn(0xF2, 0x45, 0x09, 0x08, 0x08, 0x26, 0x2A);
    lcd_cmdn(0xF3, 0x43, 0x70, 0x72, 0x36, 0x37, 0x6F);
    lcd_cmdn(0xED, 0x1B, 0x0B);
    lcd_cmdn(0xAE, 0x77);
    lcd_cmdn(0xCD, 0x63);
    lcd_cmdn(0x70, 0x07, 0x07, 0x04, 0x0E, 0x0F, 0x09, 0x07, 0x08, 0x03);
    lcd_cmdn(0xE8, 0x34);
    lcd_cmdn(0x62, 0x18, 0x0D, 0x71, 0xED, 0x70, 0x70, 0x18, 0x0F, 0x71, 0xEF, 0x70, 0x70);
    lcd_cmdn(0x63, 0x18, 0x11, 0x71, 0xF1, 0x70, 0x70, 0x18, 0x13, 0x71, 0xF3, 0x70, 0x70);
    lcd_cmdn(0x64, 0x28, 0x29, 0xF1, 0x01, 0xF1, 0x00, 0x07);
    lcd_cmdn(0x66, 0x3C, 0x00, 0xCD, 0x67, 0x45, 0x45, 0x10, 0x00, 0x00, 0x00);
    lcd_cmdn(0x67, 0x00, 0x3C, 0x00, 0x00, 0x00, 0x01, 0x54, 0x10, 0x32, 0x98);
    lcd_cmdn(0x74, 0x10, 0x85, 0x80, 0x00, 0x00, 0x4E, 0x00);
    lcd_cmdn(0x98, 0x3E, 0x07);
    lcd_cmd(0x35);
    lcd_cmd(0x21);
    lcd_cmd(0x11);
    delay(120);
    lcd_cmd(0x29);
    delay(20);
}

void lcd_init()
{
    lcd_reset();

    spi_bus_config_t buscfg = {};
    buscfg.sclk_io_num = LCD_SCLK;
    buscfg.mosi_io_num = LCD_MOSI;
    buscfg.miso_io_num = -1;
    buscfg.quadwp_io_num = -1;
    buscfg.quadhd_io_num = -1;
    buscfg.max_transfer_sz = LCD_WIDTH * BAND_ROWS * sizeof(uint16_t);
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

// lcd_flush()'s CASET / RASET / tx_color, for one band of rows.
void lcd_band(uint16_t y1, uint16_t y2, const uint16_t *pixels)
{
    const uint16_t x1 = 0;
    const uint16_t x2 = LCD_WIDTH - 1;
    const uint8_t caset[] = {(uint8_t)(x1 >> 8), (uint8_t)(x1 & 0xFF), (uint8_t)(x2 >> 8), (uint8_t)(x2 & 0xFF)};
    const uint8_t raset[] = {(uint8_t)(y1 >> 8), (uint8_t)(y1 & 0xFF), (uint8_t)(y2 >> 8), (uint8_t)(y2 & 0xFF)};
    const uint32_t before = color_done;
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(lcd_io, 0x2A, caset, sizeof(caset)));
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(lcd_io, 0x2B, raset, sizeof(raset)));
    ESP_ERROR_CHECK(esp_lcd_panel_io_tx_color(lcd_io, 0x2C, pixels, LCD_WIDTH * (y2 - y1 + 1) * sizeof(uint16_t)));
    // The buffer is reused for the next band: wait for the DMA-done callback.
    const uint32_t t0 = millis();
    while (color_done == before) {
        if (millis() - t0 > 2000) {
            Serial.println("PINBENCH-C6: tx_color timeout");
            return;
        }
        delay(1);
    }
}

// RGB565, byte-swapped as LVGL (LV_COLOR_16_SWAP) hands them to the panel.
uint16_t swapped(uint16_t rgb565)
{
    return (uint16_t)((rgb565 << 8) | (rgb565 >> 8));
}

// Top third red, middle third green, bottom third blue.
uint16_t stripe(uint16_t y)
{
    if (y < 80) return 0xF800;
    if (y < 160) return 0x07E0;
    return 0x001F;
}

// The demo's touch wiring: sda, scl, rst, irq.
CST816S touch(18, 8, 23, 4);

} // namespace

void setup()
{
    Serial.begin(115200);
    Serial.println("PINBENCH-C6: boot");

    // As in the demo, touch comes up before the panel.
    touch.begin();
    const TouchData &info = touch.get_data();
    Serial.printf("PINBENCH-C6: touch chip 0x%02X fw %u\n", info.version_info[0], info.version_info[2]);

    lcd_init();
    Serial.println("PINBENCH-C6: lcd init done");

    pinMode(LCD_BL, OUTPUT);
    digitalWrite(LCD_BL, HIGH);

    uint16_t *band = (uint16_t *)heap_caps_malloc(LCD_WIDTH * BAND_ROWS * sizeof(uint16_t), MALLOC_CAP_DMA);
    for (uint16_t y = 0; y < LCD_HEIGHT; y += BAND_ROWS) {
        const uint16_t y2 = (uint16_t)min<int>(y + BAND_ROWS - 1, LCD_HEIGHT - 1);
        for (uint16_t row = y; row <= y2; row++) {
            for (uint16_t x = 0; x < LCD_WIDTH; x++) {
                band[(row - y) * LCD_WIDTH + x] = swapped(stripe(row));
            }
        }
        lcd_band(y, y2, band);
    }
    Serial.printf("PINBENCH-C6: frame done (%lu color transfers)\n", (unsigned long)color_done);
}

void loop()
{
    static uint32_t last_alive = 0;
    if (touch.available()) {
        const TouchData &t = touch.get_data();
        Serial.printf("PINBENCH-C6: touch %u,%u event %u gesture %s\n", t.x, t.y, t.event, touch.gesture());
    }
    if (millis() - last_alive >= 1000) {
        last_alive = millis();
        Serial.println("PINBENCH-C6: alive");
    }
    delay(5);
}
