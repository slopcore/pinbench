/*
   MIT License

  Copyright (c) 2021 Felix Biego

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.
*/

#ifndef CST816S_H
#define CST816S_H

#include <Arduino.h>

#define CST816S_ADDRESS 0x15

enum class Gesture : uint8_t {
  None = 0x00,
  SwipeUp = 0x01,
  SwipeDown = 0x02,
  SwipeLeft = 0x03,
  SwipeRight = 0x04,
  SingleClick = 0x05,
  DoubleClick = 0x0B,
  LongPress = 0x0C
};

struct TouchData {
  uint8_t gesture_id; // Gesture ID
  uint8_t points; // Number of touch points
  uint8_t event; // Event (0 = Down, 1 = Up, 2 = Contact)
  uint16_t x;
  uint16_t y;
  uint8_t version;
  uint8_t version_info[3];
};

class CST816S {
  public:
    /**
     * @brief Create a CST816S touch controller driver.
     *
     * @param sda I2C data pin.
     * @param scl I2C clock pin.
     * @param rst Touch reset pin.
     * @param irq Touch interrupt pin.
     */
    CST816S(uint8_t sda, uint8_t scl, uint8_t rst, uint8_t irq);

    /**
     * @brief Initialize I2C, reset the controller, and attach the interrupt.
     *
     * @param interrupt Arduino interrupt mode such as RISING or FALLING.
     */
    void begin(int interrupt = RISING);

    /**
     * @brief Put the touch controller in standby mode.
     */
    void sleep();

    /**
     * @brief Read a pending touch event, if one was signaled by the IRQ pin.
     *
     * @return true when fresh touch data is available.
     */
    bool available();

    /**
     * @brief Get the last successfully read touch data.
     *
     * @return Reference to the cached touch data.
     */
    const TouchData &get_data() const;

    /**
     * @brief Get the current gesture name.
     *
     * @return Static string describing the gesture.
     */
    const char *gesture() const;

  private:
    uint8_t _sda;
    uint8_t _scl;
    uint8_t _rst;
    uint8_t _irq;
    volatile bool _event_available;
    TouchData data;

    void IRAM_ATTR handleISR();
    bool read_touch();

    bool i2c_read(uint8_t addr, uint8_t reg_addr, uint8_t *reg_data, uint32_t length);
    bool i2c_write(uint8_t addr, uint8_t reg_addr, const uint8_t *reg_data, uint32_t length);
};

#endif
