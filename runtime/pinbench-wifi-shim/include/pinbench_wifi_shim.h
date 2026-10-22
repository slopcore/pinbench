#pragma once

#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Manually initialize PinBench OpenETH emulation interface if needed.
 * Normally called automatically when esp_wifi_init / esp_wifi_start / esp_wifi_connect runs.
 */
esp_err_t pinbench_wifi_shim_init(void);

/**
 * Returns true if the PinBench emulated network interface is up.
 */
bool pinbench_wifi_shim_is_up(void);

#ifdef __cplusplus
}
#endif
