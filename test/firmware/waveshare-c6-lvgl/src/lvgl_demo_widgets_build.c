/*
 * PlatformIO builds only lvgl/src; the Arduino IDE also compiles lvgl/demos,
 * which the Waveshare sketch's lv_demo_widgets() comes from. Pull the widgets
 * demo in here so the vendor files stay untouched. (The lvgl library root is
 * on the include path via its library.json `includeDir: "."`.)
 */
#include "demos/widgets/lv_demo_widgets.c"
#include "demos/widgets/assets/img_clothes.c"
#include "demos/widgets/assets/img_demo_widgets_avatar.c"
#include "demos/widgets/assets/img_lvgl_logo.c"
