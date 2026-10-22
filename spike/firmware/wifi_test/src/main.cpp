#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("[WIFI_TEST] Starting WiFi test...");

  WiFi.begin("TestSSID", "TestPassword");
  Serial.print("[WIFI_TEST] Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(100);
    Serial.print(".");
  }
  Serial.println("\n[WIFI_TEST] Connected!");
  Serial.print("[WIFI_TEST] IP: ");
  Serial.println(WiFi.localIP());

  // Test scanNetworks
  int n = WiFi.scanNetworks();
  Serial.printf("[WIFI_TEST] Scan found %d networks\n", n);
  for (int i = 0; i < n; i++) {
    Serial.printf("  - %s (%d dBm)\n", WiFi.SSID(i).c_str(), WiFi.RSSI(i));
  }

  // Test HTTP Client with hostname
  HTTPClient http;
  http.begin("http://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current_weather=true");
  int code = http.GET();
  Serial.printf("[WIFI_TEST] HTTP GET code: %d\n", code);
  if (code > 0) {
    String payload = http.getString();
    Serial.printf("[WIFI_TEST] Payload length: %d\n", (int)payload.length());
    Serial.println("[WIFI_TEST] WIFI_TEST_SUCCESS");
  } else {
    Serial.printf("[WIFI_TEST] HTTP failed: %s\n", http.errorToString(code).c_str());
  }
  http.end();
}

void loop() {
  delay(1000);
}
