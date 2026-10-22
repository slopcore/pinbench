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

#include "Arduino.h"
#include <Wire.h>
#include <FunctionalInterrupt.h>

#include "CST816S.h"


/*!
    @brief  Constructor for CST816S
	@param	sda
			i2c data pin
	@param	scl
			i2c clock pin
	@param	rst
			touch reset pin
	@param	irq
			touch interrupt pin
*/
CST816S::CST816S(uint8_t sda, uint8_t scl, uint8_t rst, uint8_t irq)
  : _sda(sda),
    _scl(scl),
    _rst(rst),
    _irq(irq),
    _event_available(false),
    data{}
{
}

/*!
    @brief  read touch data
*/
bool CST816S::read_touch() {
  uint8_t data_raw[6] = {};
  if (!i2c_read(CST816S_ADDRESS, 0x01, data_raw, sizeof(data_raw))) {
    return false;
  }

  data.gesture_id = data_raw[0];
  data.points = data_raw[1];
  data.event = data_raw[2] >> 6;
  data.x = ((data_raw[2] & 0xF) << 8) + data_raw[3];
  data.y = ((data_raw[4] & 0xF) << 8) + data_raw[5];
  return true;
}

/*!
    @brief  handle interrupts
*/
void IRAM_ATTR CST816S::handleISR(void) {
  _event_available = true;

}

/*!
    @brief  initialize the touch screen
	@param	interrupt
			type of interrupt FALLING, RISING..
*/
void CST816S::begin(int interrupt) {
  Wire.begin(_sda, _scl);

  pinMode(_irq, INPUT_PULLUP);
  pinMode(_rst, OUTPUT);

  digitalWrite(_rst, HIGH);
  delay(50);
  digitalWrite(_rst, LOW);
  delay(5);
  digitalWrite(_rst, HIGH);
  delay(50);

  if (!i2c_read(CST816S_ADDRESS, 0x15, &data.version, 1)) {
    Serial.println("Failed to read CST816S version");
  }
  delay(5);
  if (!i2c_read(CST816S_ADDRESS, 0xA7, data.version_info, sizeof(data.version_info))) {
    Serial.println("Failed to read CST816S version info");
  }

  attachInterrupt(_irq, std::bind(&CST816S::handleISR, this), interrupt);
}

/*!
    @brief  check for a touch event
*/
bool CST816S::available() {
  if (_event_available) {
    _event_available = false;
    return read_touch();
  }
  return false;
}

/*!
    @brief  put the touch screen in standby mode
*/
void CST816S::sleep() {
  digitalWrite(_rst, LOW);
  delay(5);
  digitalWrite(_rst, HIGH);
  delay(50);
  uint8_t standby_value = 0x03;
  if (!i2c_write(CST816S_ADDRESS, 0xA5, &standby_value, 1)) {
    Serial.println("Failed to put CST816S into standby mode");
  }
}

/*!
    @brief  get the gesture event name
*/
const char *CST816S::gesture() const {
  switch (static_cast<Gesture>(data.gesture_id)) {
    case Gesture::None:
      return "NONE";
    case Gesture::SwipeDown:
      return "SWIPE DOWN";
    case Gesture::SwipeUp:
      return "SWIPE UP";
    case Gesture::SwipeLeft:
      return "SWIPE LEFT";
    case Gesture::SwipeRight:
      return "SWIPE RIGHT";
    case Gesture::SingleClick:
      return "SINGLE CLICK";
    case Gesture::DoubleClick:
      return "DOUBLE CLICK";
    case Gesture::LongPress:
      return "LONG PRESS";
    default:
      return "UNKNOWN";
  }
}

const TouchData &CST816S::get_data() const
{
  return data;
}

/*!
    @brief  read data from i2c
	@param	addr
			i2c device address
	@param	reg_addr
			device register address
	@param	reg_data
			array to copy the read data
	@param	length
			length of data
*/
bool CST816S::i2c_read(uint8_t addr, uint8_t reg_addr, uint8_t *reg_data, uint32_t length)
{
  Wire.beginTransmission(addr);
  Wire.write(reg_addr);
  if (Wire.endTransmission(true) != 0) {
    return false;
  }
  const uint8_t bytes_read = Wire.requestFrom(addr, length, true);
  if (bytes_read != length) {
    return false;
  }
  for (uint32_t i = 0; i < length; i++) {
    if (Wire.available() == 0) {
      return false;
    }
    *reg_data++ = Wire.read();
  }
  return true;
}

/*!
    @brief  write data to i2c
	@param	addr
			i2c device address
	@param	reg_addr
			device register address
	@param	reg_data
			data to be sent
	@param	length
			length of data
*/
bool CST816S::i2c_write(uint8_t addr, uint8_t reg_addr, const uint8_t *reg_data, uint32_t length)
{
  Wire.beginTransmission(addr);
  Wire.write(reg_addr);
  for (uint32_t i = 0; i < length; i++) {
    Wire.write(*reg_data++);
  }
  return Wire.endTransmission(true) == 0;
}
