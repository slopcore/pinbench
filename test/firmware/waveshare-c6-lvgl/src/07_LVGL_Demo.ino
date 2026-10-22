/* Using LVGL with Arduino requires some extra steps:
 * Be sure to read the docs here:
 * https://docs.lvgl.io/master/get-started/platforms/arduino.html
 */

#include <lvgl.h>
#include "lv_conf.h"
#include <demos/lv_demos.h>
#include "GC9A01.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"

#define EXAMPLE_LVGL_TICK_PERIOD_MS 2
#define EXAMPLE_USE_TOUCH 1

#if EXAMPLE_USE_TOUCH
#include "CST816S.h"
#endif

uint32_t screenWidth;
uint32_t screenHeight;

static lv_disp_draw_buf_t draw_buf;
static lv_color_t *buf1 = NULL;
static lv_color_t *buf2 = NULL;

// Waveshare ESP32-C6-Touch-LCD-1.28, CST816S
#define SD_CS     15
#if EXAMPLE_USE_TOUCH
#define TOUCH_SDA 18
#define TOUCH_SCL  8
#define TOUCH_RST 23
#define TOUCH_IRQ  4

CST816S touch(TOUCH_SDA, TOUCH_SCL, TOUCH_RST, TOUCH_IRQ); // sda, scl, rst, irq
#endif

#if LV_USE_LOG != 0
void my_print(const char *buf)
{
    Serial.print(buf);
    Serial.flush();
}
#endif

void example_increase_lvgl_tick(void *arg)
{
    (void)arg;
    lv_tick_inc(EXAMPLE_LVGL_TICK_PERIOD_MS);
}

#if EXAMPLE_USE_TOUCH
void my_touchpad_read(lv_indev_drv_t *indev_drv, lv_indev_data_t *data)
{
    (void)indev_drv;
    bool touched = touch.available();
    if (!touched) {
        data->state = LV_INDEV_STATE_REL;
    } else {
        const TouchData &touch_data = touch.get_data();
        data->state = LV_INDEV_STATE_PR;
        data->point.x = touch_data.x;
        data->point.y = touch_data.y;
    }
}
#endif

void setup()
{
    Serial.begin(115200);

    pinMode(SD_CS, OUTPUT);
    digitalWrite(SD_CS, HIGH);

#if EXAMPLE_USE_TOUCH
    touch.begin();
#endif
    lcd_init();
    lcd_backlight_on();

    screenWidth = LCD_WIDTH;
    screenHeight = LCD_HEIGHT;

    lv_init();
#if LV_USE_LOG != 0
    lv_log_register_print_cb(my_print);
#endif

    uint32_t lvglBufferPixels = screenWidth * screenHeight / 4;
    buf1 = (lv_color_t *)heap_caps_malloc(lvglBufferPixels * sizeof(lv_color_t), MALLOC_CAP_DMA);
    buf2 = (lv_color_t *)heap_caps_malloc(lvglBufferPixels * sizeof(lv_color_t), MALLOC_CAP_DMA);
    if (buf1 == NULL || buf2 == NULL) {
        Serial.println("LVGL draw buffer allocation failed");
        while (true) {
            delay(1000);
        }
    }

    lv_disp_draw_buf_init(&draw_buf, buf1, buf2, lvglBufferPixels);

    static lv_disp_drv_t disp_drv;
    lv_disp_drv_init(&disp_drv);
    disp_drv.hor_res = screenWidth;
    disp_drv.ver_res = screenHeight;
    disp_drv.flush_cb = lcd_flush;
    disp_drv.draw_buf = &draw_buf;
    lv_disp_drv_register(&disp_drv);

#if EXAMPLE_USE_TOUCH
    static lv_indev_drv_t indev_drv;
    lv_indev_drv_init(&indev_drv);
    indev_drv.type = LV_INDEV_TYPE_POINTER;
    indev_drv.read_cb = my_touchpad_read;
    lv_indev_drv_register(&indev_drv);
#endif

    lv_obj_t *label = lv_label_create(lv_scr_act());
    lv_label_set_text(label, "Hello Arduino and LVGL!");
    lv_obj_align(label, LV_ALIGN_CENTER, 0, 0);

    const esp_timer_create_args_t lvgl_tick_timer_args = {
        .callback = &example_increase_lvgl_tick,
        .name = "lvgl_tick"
    };

    esp_timer_handle_t lvgl_tick_timer = NULL;
    esp_err_t timer_ret = esp_timer_create(&lvgl_tick_timer_args, &lvgl_tick_timer);
    if (timer_ret != ESP_OK) {
        Serial.printf("Failed to create LVGL tick timer: %d\r\n", timer_ret);
        while (true) {
            delay(1000);
        }
    }
    timer_ret = esp_timer_start_periodic(lvgl_tick_timer, EXAMPLE_LVGL_TICK_PERIOD_MS * 1000);
    if (timer_ret != ESP_OK) {
        Serial.printf("Failed to start LVGL tick timer: %d\r\n", timer_ret);
        while (true) {
            delay(1000);
        }
    }

    lv_demo_widgets();

}

void loop()
{
    lv_timer_handler();
    delay(5);
}
