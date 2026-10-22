// Live fixture for the Waveshare ESP32-S3-ETH kit: paints the round GC9A01
// module, talks Elatec Simple Protocol to the TWN4 on UART1, and brings the
// W5500 up with the Arduino Ethernet library (DHCP, an HTTP GET to the
// gateway, a TCP echo server), printing PINBENCH-S3 markers on UART0 for
// src/main/s3-eth-kit-live.test.ts.

#include <Arduino.h>
#include <Ethernet.h>
#include <SPI.h>

namespace {

// Round LCD module on the header (see the board profile).
constexpr int LCD_SCK = 40;
constexpr int LCD_MOSI = 41;
constexpr int LCD_CS = 39;
constexpr int LCD_DC = 38;
constexpr int LCD_RST = 42;
constexpr int LCD_BL = 1;
constexpr uint16_t LCD_W = 240;
constexpr uint16_t LCD_H = 240;

// TWN4 on UART1: ESP TX GPIO17 → TWN4 RXD, TWN4 TXD → ESP RX GPIO16.
constexpr int TWN4_RX = 16;
constexpr int TWN4_TX = 17;

// W5500 at Waveshare's pins, on the default (FSPI) SPI the library uses.
constexpr int ETH_SCK = 13;
constexpr int ETH_MISO = 12;
constexpr int ETH_MOSI = 11;
constexpr int ETH_CS = 14;
constexpr int ETH_RST = 9;
// The live test serves HTTP here on the host, i.e. the gateway 10.0.2.2.
constexpr uint16_t HTTP_PORT = 18080;
constexpr uint16_t ECHO_PORT = 18081;

// arduino-esp32's Server declares a pure begin(uint16_t) the Ethernet
// library's EthernetServer does not implement.
class KitServer : public EthernetServer {
public:
    using EthernetServer::EthernetServer;
    void begin(uint16_t = 0) override { EthernetServer::begin(); }
};

KitServer echoServer(ECHO_PORT);

SPIClass lcdSpi(HSPI);
const SPISettings lcdSettings(40000000, MSBFIRST, SPI_MODE0);

void lcd_cmd(uint8_t cmd, const uint8_t *data = nullptr, size_t len = 0)
{
    lcdSpi.beginTransaction(lcdSettings);
    digitalWrite(LCD_CS, LOW);
    digitalWrite(LCD_DC, LOW);
    lcdSpi.transfer(cmd);
    if (len) {
        digitalWrite(LCD_DC, HIGH);
        lcdSpi.writeBytes(data, len);
    }
    digitalWrite(LCD_CS, HIGH);
    lcdSpi.endTransaction();
}

template <typename... Bytes>
void lcd_cmdn(uint8_t cmd, Bytes... bytes)
{
    const uint8_t data[] = {static_cast<uint8_t>(bytes)...};
    lcd_cmd(cmd, data, sizeof(data));
}

// Waveshare's GC9A01 vendor init (1.28inch LCD Module demo), abridged to the
// commands a panel needs to show pixels plus the vendor unlock.
void lcd_init()
{
    pinMode(LCD_CS, OUTPUT);
    pinMode(LCD_DC, OUTPUT);
    pinMode(LCD_RST, OUTPUT);
    digitalWrite(LCD_CS, HIGH);
    digitalWrite(LCD_RST, HIGH);
    delay(50);
    digitalWrite(LCD_RST, LOW);
    delay(50);
    digitalWrite(LCD_RST, HIGH);
    delay(120);
    lcdSpi.begin(LCD_SCK, -1, LCD_MOSI, -1);

    lcd_cmd(0xEF);
    lcd_cmdn(0xEB, 0x14);
    lcd_cmd(0xFE);
    lcd_cmd(0xEF);
    lcd_cmdn(0xEB, 0x14);
    lcd_cmdn(0x84, 0x40);
    lcd_cmdn(0xB6, 0x00, 0x20);
    lcd_cmdn(0x36, 0x08);
    lcd_cmdn(0x3A, 0x05);
    lcd_cmdn(0x90, 0x08, 0x08, 0x08, 0x08);
    lcd_cmdn(0xC3, 0x13);
    lcd_cmdn(0xC4, 0x13);
    lcd_cmdn(0xC9, 0x22);
    lcd_cmd(0x35);
    lcd_cmd(0x21);
    lcd_cmd(0x11);
    delay(120);
    lcd_cmd(0x29);
    delay(20);
}

uint16_t stripe(uint16_t y)
{
    if (y < 80) return 0xF800;
    if (y < 160) return 0x07E0;
    return 0x001F;
}

void lcd_paint()
{
    lcd_cmdn(0x2A, 0, 0, 0, LCD_W - 1);
    lcd_cmdn(0x2B, 0, 0, 0, LCD_H - 1);
    static uint8_t row[LCD_W * 2];
    lcdSpi.beginTransaction(lcdSettings);
    digitalWrite(LCD_CS, LOW);
    digitalWrite(LCD_DC, LOW);
    lcdSpi.transfer(0x2C);
    digitalWrite(LCD_DC, HIGH);
    for (uint16_t y = 0; y < LCD_H; y++) {
        const uint16_t c = stripe(y);
        for (uint16_t x = 0; x < LCD_W; x++) {
            row[2 * x] = c >> 8;
            row[2 * x + 1] = c & 0xFF;
        }
        lcdSpi.writeBytes(row, sizeof(row));
    }
    digitalWrite(LCD_CS, HIGH);
    lcdSpi.endTransaction();
}

// One Simple Protocol exchange: hex command + CR out, hex reply line back.
String twn4(const char *hex, uint32_t timeoutMs = 500)
{
    while (Serial1.available()) Serial1.read();
    Serial1.print(hex);
    Serial1.print('\r');
    String reply;
    const uint32_t t0 = millis();
    while (millis() - t0 < timeoutMs) {
        while (Serial1.available()) {
            const char c = (char)Serial1.read();
            if (c == '\r') return reply;
            reply += c;
        }
        delay(1);
    }
    return String("TIMEOUT:") + reply;
}

String lastTag;

void eth_init()
{
    pinMode(ETH_RST, OUTPUT);
    digitalWrite(ETH_RST, LOW);
    delay(10);
    digitalWrite(ETH_RST, HIGH);
    delay(50);
    SPI.begin(ETH_SCK, ETH_MISO, ETH_MOSI, -1);
    Ethernet.init(ETH_CS);

    byte mac[] = {0x02, 0x50, 0x42, 0x00, 0x55, 0x00};
    const int dhcp = Ethernet.begin(mac, 10000, 2000);
    Serial.printf("PINBENCH-S3: eth hw %d link %d dhcp %d ip %s gw %s dns %s\n",
                  (int)Ethernet.hardwareStatus(), (int)Ethernet.linkStatus(), dhcp,
                  Ethernet.localIP().toString().c_str(), Ethernet.gatewayIP().toString().c_str(),
                  Ethernet.dnsServerIP().toString().c_str());

    EthernetClient http;
    if (http.connect(Ethernet.gatewayIP(), HTTP_PORT)) {
        http.print("GET /kit HTTP/1.0\r\nHost: pinbench\r\n\r\n");
        String status;
        String body;
        bool inBody = false;
        String line;
        const uint32_t t0 = millis();
        while ((http.connected() || http.available()) && millis() - t0 < 5000) {
            while (http.available()) {
                const char c = (char)http.read();
                if (c == '\n') {
                    line.trim();
                    if (status.length() == 0) status = line;
                    else if (inBody) body += line;
                    else if (line.length() == 0) inBody = true;
                    line = "";
                } else {
                    line += c;
                }
            }
            delay(1);
        }
        if (inBody) body += line;
        http.stop();
        Serial.printf("PINBENCH-S3: http status '%s' body '%s'\n", status.c_str(), body.c_str());
    } else {
        Serial.println("PINBENCH-S3: http connect failed");
    }

    echoServer.begin();
    Serial.println("PINBENCH-S3: eth echo server up");
}

void eth_poll()
{
    EthernetClient c = echoServer.available();
    if (!c) return;
    String line;
    const uint32_t t0 = millis();
    while (c.connected() && millis() - t0 < 2000) {
        if (c.available()) {
            const char ch = (char)c.read();
            if (ch == '\n') break;
            line += ch;
        } else {
            delay(1);
        }
    }
    c.print("pong:" + line + "\n");
    c.flush();
    c.stop();
    Serial.printf("PINBENCH-S3: echo '%s'\n", line.c_str());
}

} // namespace

void setup()
{
    Serial.begin(115200);
    Serial.println("PINBENCH-S3: boot");

    lcd_init();
    pinMode(LCD_BL, OUTPUT);
    digitalWrite(LCD_BL, HIGH);
    lcd_paint();
    Serial.println("PINBENCH-S3: lcd frame done");

    Serial1.begin(9600, SERIAL_8N1, TWN4_RX, TWN4_TX);
    Serial.printf("PINBENCH-S3: twn4 version %s\n", twn4("0004FF").c_str());
    // Green LED on: GPIOSetBits(GREENLED).
    Serial.printf("PINBENCH-S3: twn4 led %s\n", twn4("040202").c_str());

    eth_init();
}

void loop()
{
    static uint32_t lastPoll = 0;
    static uint32_t lastAlive = 0;
    if (millis() - lastPoll >= 200) {
        lastPoll = millis();
        const String r = twn4("050010");
        // "0001 TT BB LL id…" → found; "0000" → no tag.
        const String tag = r.startsWith("0001") ? r.substring(10) : String();
        if (tag != lastTag) {
            lastTag = tag;
            if (tag.length()) {
                Serial.printf("PINBENCH-S3: tag type %s uid %s\n", r.substring(4, 6).c_str(), tag.c_str());
            } else {
                Serial.printf("PINBENCH-S3: tag gone (%s)\n", r.c_str());
            }
        }
    }
    eth_poll();
    if (millis() - lastAlive >= 1000) {
        lastAlive = millis();
        Serial.println("PINBENCH-S3: alive");
    }
    delay(5);
}
