// ============================================================================
//  Solar-Tracking Smart Irrigation – hardware configuration
//  Edit this file to match your wiring. Everything else can be changed from
//  the web dashboard (Setup tab) and is saved in the ESP32 flash.
// ============================================================================
#pragma once

// ---------------- Wi-Fi ----------------
// The ESP32 always creates its own hotspot so the dashboard works in the field
// without internet. Change the password before deploying (min. 8 characters).
#define AP_SSID        "SolarIrrigation"
#define AP_PASSWORD    "irrigate123"
#define MDNS_NAME      "irrigation"        // -> http://irrigation.local
// Optional: connect to a farm/home router too (can also be set from the dashboard).
#define STA_SSID       ""
#define STA_PASSWORD   ""

// Time zone offset in minutes (Myanmar = UTC+6:30 = 390)
#define TZ_OFFSET_MIN  390

// ---------------- Pins (ESP32 DevKit V1) ----------------
// Only ADC1 pins (32-39) can be used for analog while Wi-Fi is on.
#define PIN_SOIL_1       34   // capacitive soil moisture sensor 1 (AOUT)
#define PIN_SOIL_2       35   // sensor 2
#define PIN_SOIL_3       32   // sensor 3
#define SOIL_SENSOR_COUNT 3   // 1..3

#define PIN_DHT          4    // DHT22 data (10k pull-up to 3.3V)
#define PIN_BAT_V        36   // VP – battery voltage divider
#define PIN_SOLAR_V      39   // VN – solar panel voltage divider
#define PIN_SOLAR_I      33   // ACS712 output through divider (optional)

// Motor driver. Works with IBT-2 (BTS7960, recommended) or L298N:
//   IBT-2 : RPWM -> PIN_PUMP_PWM, LPWM -> PIN_PUMP_B, R_EN + L_EN -> PIN_PUMP_A
//   L298N : ENA  -> PIN_PUMP_PWM, IN1  -> PIN_PUMP_A, IN2  -> PIN_PUMP_B
#define PIN_PUMP_PWM     25
#define PIN_PUMP_A       26   // held HIGH
#define PIN_PUMP_B       27   // held LOW
#define PUMP_PWM_FREQ    20000  // 20 kHz for IBT-2 (silent). Use 1000 for L298N.

#define PIN_SERVO        13   // solar tracker servo (east-west axis)
#define PIN_STATUS_LED   2

// ---------------- Analog scaling ----------------
// Voltage divider ratio = (R1 + R2) / R2
#define BAT_DIVIDER      5.545f   // 100k / 22k  -> up to 18 V
#define SOLAR_DIVIDER    7.667f   // 100k / 15k  -> up to 25 V
#define USE_CURRENT_SENSOR 1      // 0 = no ACS712 fitted
#define ACS_DIVIDER      1.5f     // 10k / 20k divider on the 5 V ACS712 output
#define ACS_ZERO_V       2.50f    // ACS712 output at 0 A
#define ACS_V_PER_A      0.185f   // 5 A version = 0.185, 20 A = 0.100, 30 A = 0.066

// Soil sensor raw ADC defaults (calibrate from the dashboard: Control tab)
#define SOIL_RAW_DRY     3200     // sensor in dry air / dry soil
#define SOIL_RAW_WET     1300     // sensor in water / saturated soil

// ---------------- Servo ----------------
#define SERVO_MIN_US     500
#define SERVO_MAX_US     2500
#define TRACK_EAST_DEG   15       // panel angle at sunrise
#define TRACK_WEST_DEG   165      // panel angle at sunset
#define SUNRISE_HOUR     6.0f
#define SUNSET_HOUR      18.0f
#define TRACK_STEP_MIN   15       // move the panel every 15 minutes

// ---------------- Cloud (optional, free Firebase) ----------------
// Lets you watch and control the farm from anywhere via the hosted dashboard.
// Needs the ESP32 to join a router with internet (STA_SSID above, or the
// dashboard's Wi-Fi form). Requires the "ArduinoJson" library (v7).
// See the "Cloud setup" section in README.md.
#define CLOUD_ENABLED    0                     // 1 = send data to Firebase
#define FB_API_KEY       ""                    // Project settings -> Web API key
#define FB_DATABASE_URL  ""                    // e.g. https://my-farm-default-rtdb.asia-southeast1.firebasedatabase.app
#define FB_EMAIL         ""                    // the controller's Firebase user
#define FB_PASSWORD      ""
#define FB_DEVICE_PATH   "farm1"               // must match devicePath in web/js/cloud-config.js
#define CLOUD_STATUS_MS  10000                 // upload live status every 10 s
#define CLOUD_CMD_MS     3000                  // check for commands every 3 s
