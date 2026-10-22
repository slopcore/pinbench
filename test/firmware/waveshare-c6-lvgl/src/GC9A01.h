#ifndef GC9A01_H
#define GC9A01_H

#include "lv_conf.h"
#include <lvgl.h>
#include <stdint.h>

// Waveshare ESP32-C6-Touch-LCD-1.28, GC9A01
constexpr uint16_t LCD_WIDTH = 240;
constexpr uint16_t LCD_HEIGHT = 240;

/**
 * @brief Initialize the SPI bus and GC9A01 LCD panel.
 */
void lcd_init();

/**
 * @brief Enable the LCD backlight GPIO.
 */
void lcd_backlight_on();

/**
 * @brief Flush an LVGL draw area to the LCD panel.
 *
 * @param disp_drv LVGL display driver that issued the flush.
 * @param area Area to update.
 * @param color_p Pixel buffer in LVGL color format.
 */
void lcd_flush(lv_disp_drv_t *disp_drv, const lv_area_t *area, lv_color_t *color_p);

#endif
