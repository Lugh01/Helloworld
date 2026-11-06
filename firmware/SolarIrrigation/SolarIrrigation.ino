// ============================================================================
//  Automated Solar-Tracking Irrigation System – ESP32 firmware
//  Project: Sustainable Agriculture in the Central Dry Zone of Myanmar
//
//  - Reads up to 3 capacitive soil moisture sensors, DHT22, battery & solar
//  - Controls a DC pump with PWM (speed follows the soil's water need)
//  - Time-based single-axis solar tracking with a servo
//  - Hosts the IoT dashboard (data/index.html on LittleFS) + JSON API
//
//  Libraries: "DHT sensor library" by Adafruit (+ Adafruit Unified Sensor).
//  Board: ESP32 Dev Module (esp32 core 2.x or 3.x).
//  Upload the sketch, then upload the data/ folder to LittleFS.
//  Cloud (optional): also install "ArduinoJson" (v7) and set CLOUD_ENABLED 1.
// ============================================================================
#include <Arduino.h>
#include <esp_arduino_version.h>
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <LittleFS.h>
#include <Preferences.h>
#include <time.h>
#include <sys/time.h>
#include <DHT.h>
#include <map>
#include "config.h"

#define FW_VERSION "1.1.0"

// Command arguments (from a web form or a cloud command) and command result
struct Args {
  std::map<String, String> m;
  bool has(const char *k) const { return m.count(String(k)) > 0; }
  String arg(const char *k) const { auto it = m.find(String(k)); return it == m.end() ? String("") : it->second; }
};
struct Result { bool ok; String msg; };


// ---------------------------------------------------------------------------
//  Settings (editable from the dashboard, stored in NVS flash)
// ---------------------------------------------------------------------------
struct Settings {
  uint8_t  crop        = 0;      // 0 tomato, 1 chili, 2 onion, 3 custom
  float    startPct    = 45;     // start watering below this soil moisture
  float    targetPct   = 70;     // stop watering at this soil moisture
  float    criticalPct = 30;     // full speed below this; may water outside windows
  uint8_t  minSpeed    = 45;     // % PWM for a small water deficit
  uint16_t pulseRunSec = 300;    // longest continuous run (5 min)
  uint16_t soakSec     = 600;    // pause to let water soak in (10 min)
  bool     useWindows  = true;   // prefer cool hours (less evaporation)
  uint8_t  w1Start = 5, w1End = 9, w2Start = 16, w2End = 19;
  float    batCutoffV  = 11.6;   // stop pump below this battery voltage
  float    batResumeV  = 12.3;   // allow pump again above this
  uint16_t manualMaxMin = 15;    // longest manual run
  float    pumpLpm     = 8.0;    // pump flow at 100 % (litres / minute)
  float    dailyLimitL = 400;    // stop auto watering after this many litres/day
  bool     hotBoost    = true;   // +5 % target when air > 35 C
  uint8_t  noRiseMin   = 8;      // dry-run alarm after this many pump minutes w/o rise
  uint8_t  sensorCount = SOIL_SENSOR_COUNT;
  int16_t  dryRaw[3]   = {SOIL_RAW_DRY, SOIL_RAW_DRY, SOIL_RAW_DRY};
  int16_t  wetRaw[3]   = {SOIL_RAW_WET, SOIL_RAW_WET, SOIL_RAW_WET};
  int16_t  tzMin       = TZ_OFFSET_MIN;
} cfg;

Preferences prefs;
WebServer   server(80);
DHT         dht(PIN_DHT, DHT22);

// ---------------------------------------------------------------------------
//  Live state
// ---------------------------------------------------------------------------
enum Mode   { MODE_AUTO, MODE_MANUAL };
enum AState { ST_IDLE, ST_WATERING, ST_SOAKING };

Mode   mode = MODE_AUTO;
AState aState = ST_IDLE;

struct Soil { int raw; float pct; bool ok; } soil[3];
float soilAvg = NAN;
float airT = NAN, airH = NAN;
float batV = NAN, solarV = NAN, solarA = 0, solarW = 0;
bool  lowBattery = false;

int    pumpSpeed = 0;          // actual output %
int    pumpTarget = 0;         // requested %
String pumpSource = "off";     // auto | manual | off
String reason = "Starting up";
String alarm = "";             // latched alarm text (needs reset)

uint32_t manualEndMs = 0;      // manual run end (0 = not running)
int      manualSpeed = 80;
uint32_t holdEndMs = 0;        // auto paused after a manual stop
uint32_t pulseStartMs = 0, soakStartMs = 0;
float    moistAtCycleStart = 0;
float    runSecSinceRise = 0;

float trackerAngle = 90;
bool  trackerManual = false;
float trackerManualAngle = 90;

float litersToday = 0, pumpSecToday = 0, solarWhToday = 0;
int   lastDay = -1;
uint32_t dayStartMs = 0;

// History: one sample every 5 minutes for 24 h
#define HIST_N 288
#define HIST_PERIOD_MS 300000UL
struct Sample { uint32_t t; int16_t soil, temp, hum, bat, solar; uint8_t pump; } hist[HIST_N];
int histHead = 0, histCount = 0;
uint32_t lastHistMs = 0;
int newSampleSlot = -1;     // set when a new history sample is recorded (for the cloud)
float histPumpMax = 0;

// Event log
#define LOG_N 25
struct LogEntry { uint32_t t; char lvl; char msg[72]; } logs[LOG_N];
int logHead = 0, logCount = 0;

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------
bool timeValid() { return time(nullptr) > 1700000000; }

uint32_t nowStamp() {               // epoch seconds if known, else uptime seconds
  return timeValid() ? (uint32_t)time(nullptr) : millis() / 1000;
}

float localHour() {
  if (!timeValid()) return NAN;
  time_t t = time(nullptr) + cfg.tzMin * 60;
  struct tm tmv; gmtime_r(&t, &tmv);
  return tmv.tm_hour + tmv.tm_min / 60.0f;
}

int localDay() {
  if (!timeValid()) return (millis() - dayStartMs) / 86400000UL;
  time_t t = time(nullptr) + cfg.tzMin * 60;
  return t / 86400;
}

void addLog(char lvl, const String &m) {
  LogEntry &e = logs[logHead];
  e.t = nowStamp(); e.lvl = lvl;
  strncpy(e.msg, m.c_str(), sizeof(e.msg) - 1); e.msg[sizeof(e.msg) - 1] = 0;
  logHead = (logHead + 1) % LOG_N; if (logCount < LOG_N) logCount++;
  Serial.printf("[%c] %s\n", lvl, m.c_str());
}

String jnum(float v, int d = 1) { return isnan(v) ? String("null") : String(v, d); }
String jstr(const String &s) {
  String o = "\""; for (char c : s) { if (c == '"' || c == '\\') o += '\\'; o += c; } return o + "\"";
}

// ---------------------------------------------------------------------------
//  Settings persistence
// ---------------------------------------------------------------------------
void saveSettings() {
  prefs.begin("irr", false);
  prefs.putBytes("cfg", &cfg, sizeof(cfg));
  prefs.end();
}
void loadSettings() {
  prefs.begin("irr", true);
  if (prefs.getBytesLength("cfg") == sizeof(cfg)) prefs.getBytes("cfg", &cfg, sizeof(cfg));
  prefs.end();
}

// ---------------------------------------------------------------------------
//  Outputs
// ---------------------------------------------------------------------------
void pwmInit() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(PIN_PUMP_PWM, PUMP_PWM_FREQ, 8);
  ledcAttach(PIN_SERVO, 50, 16);
#else
  ledcSetup(0, PUMP_PWM_FREQ, 8); ledcAttachPin(PIN_PUMP_PWM, 0);
  ledcSetup(2, 50, 16);           ledcAttachPin(PIN_SERVO, 2);
#endif
}
void writePump(int pct) {
  uint32_t duty = map(constrain(pct, 0, 100), 0, 100, 0, 255);
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(PIN_PUMP_PWM, duty);
#else
  ledcWrite(0, duty);
#endif
}
void writeServo(float deg) {
  float us = SERVO_MIN_US + (SERVO_MAX_US - SERVO_MIN_US) * constrain(deg, 0, 180) / 180.0f;
  uint32_t duty = (uint32_t)(us / 20000.0f * 65535.0f);
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(PIN_SERVO, duty);
#else
  ledcWrite(2, duty);
#endif
}

// ---------------------------------------------------------------------------
//  Sensors
// ---------------------------------------------------------------------------
const uint8_t soilPins[3] = {PIN_SOIL_1, PIN_SOIL_2, PIN_SOIL_3};

int readAvg(uint8_t pin, int n = 16) { long s = 0; for (int i = 0; i < n; i++) s += analogRead(pin); return s / n; }
float readVolts(uint8_t pin, int n = 16) { long s = 0; for (int i = 0; i < n; i++) s += analogReadMilliVolts(pin); return s / (float)n / 1000.0f; }

void readSoil() {
  float sum = 0; int n = 0;
  for (int i = 0; i < 3; i++) {
    if (i >= cfg.sensorCount) { soil[i] = {0, NAN, false}; continue; }
    int raw = readAvg(soilPins[i]);
    // Disconnected / shorted sensors read near 0 or 4095
    bool ok = raw > 200 && raw < 4000;
    float span = cfg.dryRaw[i] - cfg.wetRaw[i];
    float pct = span != 0 ? (cfg.dryRaw[i] - raw) * 100.0f / span : NAN;
    pct = constrain(pct, 0, 100);
    // light smoothing
    if (ok && !isnan(soil[i].pct) && soil[i].ok) pct = soil[i].pct * 0.7f + pct * 0.3f;
    soil[i] = {raw, ok ? pct : NAN, ok};
    if (ok) { sum += pct; n++; }
  }
  soilAvg = n ? sum / n : NAN;
}

float batteryPercent(float v) {   // 12 V lead-acid / AGM, resting voltage
  const float V[] = {10.5, 11.51, 11.66, 11.81, 11.96, 12.10, 12.24, 12.37, 12.50, 12.62, 12.73};
  if (isnan(v)) return NAN;
  if (v <= V[0]) return 0; if (v >= V[10]) return 100;
  for (int i = 1; i <= 10; i++) if (v < V[i]) return (i - 1) * 10 + 10 * (v - V[i - 1]) / (V[i] - V[i - 1]);
  return 100;
}

void readPower() {
  batV = readVolts(PIN_BAT_V) * BAT_DIVIDER;
  solarV = readVolts(PIN_SOLAR_V) * SOLAR_DIVIDER;
#if USE_CURRENT_SENSOR
  float a = (readVolts(PIN_SOLAR_I, 32) * ACS_DIVIDER - ACS_ZERO_V) / ACS_V_PER_A;
  solarA = a < 0.05f ? 0 : a;
  solarW = solarV * solarA;
#else
  solarA = NAN; solarW = NAN;
#endif
  if (batV < 3) batV = NAN;   // divider not connected
  if (!isnan(batV)) {
    if (!lowBattery && batV < cfg.batCutoffV) { lowBattery = true;  addLog('w', "Battery low (" + String(batV, 2) + " V) - pump disabled"); }
    if (lowBattery && batV > cfg.batResumeV)  { lowBattery = false; addLog('i', "Battery recovered - pump allowed"); }
  }
}

uint32_t lastDhtMs = 0;
void readAir() {
  if (millis() - lastDhtMs < 2500) return;
  lastDhtMs = millis();
  float t = dht.readTemperature(), h = dht.readHumidity();
  if (!isnan(t) && !isnan(h)) { airT = t; airH = h; }
  else { airT = NAN; airH = NAN; }
}

// ---------------------------------------------------------------------------
//  Irrigation control
// ---------------------------------------------------------------------------
float effectiveTarget() {
  float t = cfg.targetPct;
  if (cfg.hotBoost && !isnan(airT) && airT > 35) t += 5;
  return min(t, 95.0f);
}

bool inWateringWindow() {
  if (!cfg.useWindows) return true;
  float h = localHour();
  if (isnan(h)) return true;    // unknown time: do not block watering
  return (h >= cfg.w1Start && h < cfg.w1End) || (h >= cfg.w2Start && h < cfg.w2End);
}

// Proportional speed: drier soil -> faster pump (as in the proposal)
int autoSpeed(float m) {
  float tgt = effectiveTarget();
  if (m <= cfg.criticalPct) return 100;
  float deficit = (tgt - m) / max(1.0f, tgt - cfg.criticalPct);
  deficit = constrain(deficit, 0, 1);
  return cfg.minSpeed + (int)(deficit * (100 - cfg.minSpeed));
}

void enterIdle(const String &why) { aState = ST_IDLE; reason = why; }

void controlLoop(float dt) {
  uint32_t now = millis();
  int want = 0; String src = "off";

  // 1) Manual timed run (works in Auto and Manual mode)
  if (manualEndMs && (int32_t)(manualEndMs - now) <= 0) {
    manualEndMs = 0; addLog('i', "Manual run finished");
    if (mode == MODE_AUTO) holdEndMs = now + 30UL * 60000UL;
  }
  if (manualEndMs) {
    if (!isnan(soilAvg) && soilAvg >= 95) { manualEndMs = 0; addLog('i', "Manual run stopped: soil saturated"); }
    else { want = manualSpeed; src = "manual"; reason = "Manual run"; }
  }

  // 2) Automatic control
  if (!manualEndMs) {
    if (mode == MODE_MANUAL) { reason = "Manual mode - press Run pump to water"; aState = ST_IDLE; }
    else if (holdEndMs && (int32_t)(holdEndMs - now) > 0) { reason = "Auto paused after manual stop"; aState = ST_IDLE; }
    else if (alarm.length()) { reason = "Alarm - check system, then reset"; aState = ST_IDLE; }
    else if (isnan(soilAvg)) { reason = "No valid soil sensor - auto watering stopped"; aState = ST_IDLE; }
    else if (litersToday >= cfg.dailyLimitL) { reason = "Daily water limit reached"; aState = ST_IDLE; }
    else {
      holdEndMs = 0;
      float tgt = effectiveTarget();
      bool allowed = inWateringWindow() || soilAvg < cfg.criticalPct;
      switch (aState) {
        case ST_IDLE:
          if (soilAvg < cfg.startPct && allowed) {
            aState = ST_WATERING; pulseStartMs = now; moistAtCycleStart = soilAvg; runSecSinceRise = 0;
            addLog('i', "Auto watering started (soil " + String(soilAvg, 0) + "%)");
          } else if (soilAvg < cfg.startPct) reason = "Soil dry - waiting for watering window";
          else reason = "Soil moisture OK";
          break;
        case ST_WATERING:
          if (soilAvg >= tgt) { addLog('i', "Target reached (" + String(soilAvg, 0) + "%) - pump stopped"); enterIdle("Target reached"); }
          else if (!allowed) { addLog('i', "Watering window closed"); enterIdle("Outside watering window"); }
          else if (now - pulseStartMs >= cfg.pulseRunSec * 1000UL) { aState = ST_SOAKING; soakStartMs = now; }
          else { want = autoSpeed(soilAvg); src = "auto"; reason = "Watering: soil below target"; }
          break;
        case ST_SOAKING:
          reason = "Soaking - letting water reach the roots";
          if (soilAvg >= tgt) enterIdle("Target reached");
          else if (now - soakStartMs >= cfg.soakSec * 1000UL) { aState = ST_WATERING; pulseStartMs = now; }
          break;
      }
    }
  }

  // 3) Hard safety: battery
  if (want > 0 && lowBattery) { want = 0; src = "off"; reason = "Battery low - pump locked out"; }

  // 4) Dry-run protection: pump running but soil not getting wetter
  if (want > 0 && src == "auto") {
    runSecSinceRise += dt;
    if (soilAvg > moistAtCycleStart + 2) { moistAtCycleStart = soilAvg; runSecSinceRise = 0; }
    if (runSecSinceRise > cfg.noRiseMin * 60) {
      alarm = "No moisture rise while pumping - check water tank, pipes and sensors";
      addLog('e', alarm); want = 0; src = "off"; aState = ST_IDLE;
    }
  }

  pumpTarget = want; pumpSource = want ? src : "off";
  // Soft start / stop: max 10 % change per 100 ms
  if (pumpSpeed < pumpTarget) pumpSpeed = min(pumpTarget, pumpSpeed + 10);
  else if (pumpSpeed > pumpTarget) pumpSpeed = max(pumpTarget, pumpSpeed - 20);
  writePump(pumpSpeed);
  digitalWrite(PIN_STATUS_LED, pumpSpeed > 0);
}

// ---------------------------------------------------------------------------
//  Solar tracker (time based)
// ---------------------------------------------------------------------------
uint32_t lastTrackMs = 0;
void trackerLoop() {
  float target;
  if (trackerManual) target = trackerManualAngle;
  else {
    if (millis() - lastTrackMs < TRACK_STEP_MIN * 60000UL && lastTrackMs) return;
    float h = localHour();
    if (isnan(h)) target = 90;                                       // time unknown: face up
    else if (h < SUNRISE_HOUR || h > SUNSET_HOUR + 0.5f) target = TRACK_EAST_DEG; // park east for morning
    else {
      float f = constrain((h - SUNRISE_HOUR) / (SUNSET_HOUR - SUNRISE_HOUR), 0, 1);
      target = TRACK_EAST_DEG + f * (TRACK_WEST_DEG - TRACK_EAST_DEG);
    }
    lastTrackMs = millis();
  }
  if (fabs(target - trackerAngle) >= 0.5f) { trackerAngle = target; writeServo(trackerAngle); }
}

// ---------------------------------------------------------------------------
//  Daily totals and history
// ---------------------------------------------------------------------------
void totalsLoop(float dt) {
  int d = localDay();
  if (lastDay != -1 && d != lastDay) { litersToday = 0; pumpSecToday = 0; solarWhToday = 0; addLog('i', "New day - counters reset"); }
  lastDay = d;
  if (pumpSpeed > 0) { litersToday += cfg.pumpLpm * pumpSpeed / 100.0f * dt / 60.0f; pumpSecToday += dt; }
  if (!isnan(solarW)) solarWhToday += solarW * dt / 3600.0f;
  histPumpMax = max(histPumpMax, (float)pumpSpeed);

  if (millis() - lastHistMs >= HIST_PERIOD_MS || !lastHistMs) {
    lastHistMs = millis();
    Sample &s = hist[histHead];
    s.t = nowStamp();
    s.soil = isnan(soilAvg) ? -1 : soilAvg * 10;
    s.temp = isnan(airT) ? -999 : airT * 10;
    s.hum  = isnan(airH) ? -1 : airH * 10;
    s.bat  = isnan(batV) ? -1 : batV * 100;
    s.solar = isnan(solarW) ? -1 : solarW * 10;
    s.pump = histPumpMax; histPumpMax = 0;
    newSampleSlot = histHead;
    histHead = (histHead + 1) % HIST_N; if (histCount < HIST_N) histCount++;
  }
}

// ---------------------------------------------------------------------------
//  Web API
// ---------------------------------------------------------------------------
String settingsJson() {
  String j = "{";
  j += "\"crop\":" + String(cfg.crop);
  j += ",\"startPct\":" + jnum(cfg.startPct, 0) + ",\"targetPct\":" + jnum(cfg.targetPct, 0) + ",\"criticalPct\":" + jnum(cfg.criticalPct, 0);
  j += ",\"minSpeed\":" + String(cfg.minSpeed) + ",\"pulseRunSec\":" + String(cfg.pulseRunSec) + ",\"soakSec\":" + String(cfg.soakSec);
  j += ",\"useWindows\":" + String(cfg.useWindows ? "true" : "false");
  j += ",\"w1Start\":" + String(cfg.w1Start) + ",\"w1End\":" + String(cfg.w1End) + ",\"w2Start\":" + String(cfg.w2Start) + ",\"w2End\":" + String(cfg.w2End);
  j += ",\"batCutoffV\":" + jnum(cfg.batCutoffV, 2) + ",\"batResumeV\":" + jnum(cfg.batResumeV, 2);
  j += ",\"manualMaxMin\":" + String(cfg.manualMaxMin) + ",\"pumpLpm\":" + jnum(cfg.pumpLpm, 1) + ",\"dailyLimitL\":" + jnum(cfg.dailyLimitL, 0);
  j += ",\"hotBoost\":" + String(cfg.hotBoost ? "true" : "false") + ",\"noRiseMin\":" + String(cfg.noRiseMin);
  j += ",\"sensorCount\":" + String(cfg.sensorCount) + ",\"tzMin\":" + String(cfg.tzMin);
  j += ",\"dryRaw\":[" + String(cfg.dryRaw[0]) + "," + String(cfg.dryRaw[1]) + "," + String(cfg.dryRaw[2]) + "]";
  j += ",\"wetRaw\":[" + String(cfg.wetRaw[0]) + "," + String(cfg.wetRaw[1]) + "," + String(cfg.wetRaw[2]) + "]";
  return j + "}";
}

const char *stateName() {
  if (manualEndMs) return "manual";
  if (lowBattery) return "lockout";
  if (alarm.length()) return "alarm";
  if (holdEndMs && (int32_t)(holdEndMs - millis()) > 0) return "hold";
  if (mode == MODE_MANUAL) return "manual-idle";
  return aState == ST_WATERING ? "watering" : aState == ST_SOAKING ? "soaking" : "idle";
}

String statusJson() {
  uint32_t now = millis();
  String j; j.reserve(3000);
  j = "{\"fw\":\"" FW_VERSION "\",\"uptime\":" + String(now / 1000);
  j += ",\"time\":" + String(timeValid() ? (uint32_t)time(nullptr) : 0) + ",\"tzMin\":" + String(cfg.tzMin);
  j += ",\"mode\":\"" + String(mode == MODE_AUTO ? "auto" : "manual") + "\"";
  j += ",\"pump\":{\"speed\":" + String(pumpSpeed) + ",\"target\":" + String(pumpTarget) + ",\"source\":" + jstr(pumpSource);
  j += ",\"state\":\"" + String(stateName()) + "\",\"reason\":" + jstr(reason);
  j += ",\"manualLeft\":" + String(manualEndMs ? (manualEndMs - now) / 1000 : 0);
  j += ",\"holdLeft\":" + String(holdEndMs && (int32_t)(holdEndMs - now) > 0 ? (holdEndMs - now) / 1000 : 0);
  j += ",\"pulseLeft\":" + String(aState == ST_WATERING && !manualEndMs ? max(0L, (long)cfg.pulseRunSec - (long)(now - pulseStartMs) / 1000) : 0);
  j += ",\"soakLeft\":" + String(aState == ST_SOAKING ? max(0L, (long)cfg.soakSec - (long)(now - soakStartMs) / 1000) : 0);
  j += ",\"manualSpeed\":" + String(manualSpeed) + "}";
  j += ",\"soil\":{\"avg\":" + jnum(soilAvg) + ",\"effTarget\":" + jnum(effectiveTarget(), 0) + ",\"sensors\":[";
  for (int i = 0; i < cfg.sensorCount; i++) {
    if (i) j += ",";
    j += "{\"raw\":" + String(soil[i].raw) + ",\"pct\":" + jnum(soil[i].pct) + ",\"ok\":" + (soil[i].ok ? "true" : "false") + "}";
  }
  j += "]},\"air\":{\"temp\":" + jnum(airT) + ",\"hum\":" + jnum(airH) + "}";
  j += ",\"power\":{\"batV\":" + jnum(batV, 2) + ",\"batPct\":" + jnum(batteryPercent(batV), 0) + ",\"solarV\":" + jnum(solarV, 1);
  j += ",\"solarA\":" + jnum(solarA, 2) + ",\"solarW\":" + jnum(solarW, 1) + ",\"lowBattery\":" + (lowBattery ? "true" : "false") + "}";
  j += ",\"tracker\":{\"angle\":" + jnum(trackerAngle, 0) + ",\"manual\":" + (trackerManual ? "true" : "false") + "}";
  j += ",\"today\":{\"liters\":" + jnum(litersToday, 1) + ",\"pumpMin\":" + jnum(pumpSecToday / 60, 1) + ",\"solarWh\":" + jnum(solarWhToday, 1) + "}";
  j += ",\"alarm\":" + jstr(alarm);
  j += ",\"wifi\":{\"ap\":\"" AP_SSID "\",\"sta\":" + jstr(WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : "") + ",\"rssi\":" + String(WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0) + "}";
  j += ",\"settings\":" + settingsJson();
  j += ",\"events\":[";
  for (int k = 0; k < logCount; k++) {
    LogEntry &e = logs[(logHead - 1 - k + LOG_N) % LOG_N];
    if (k) j += ",";
    j += "{\"t\":" + String(e.t) + ",\"l\":\"" + String(e.lvl) + "\",\"m\":" + jstr(e.msg) + "}";
  }
  j += "]}";
  return j;
}

String sampleRow(const Sample &s) {
  return "[" + String(s.t) + "," + String(s.soil) + "," + String(s.temp) + "," + String(s.hum) + "," + String(s.bat) + "," + String(s.solar) + "," + String(s.pump) + "]";
}

void handleStatus() {
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", statusJson());
}

void handleHistory() {
  String j; j.reserve(histCount * 40 + 200);
  j = "{\"period\":300,\"timeValid\":" + String(timeValid() ? "true" : "false") + ",\"now\":" + String(nowStamp()) + ",\"rows\":[";
  int start = (histHead - histCount + HIST_N) % HIST_N;
  for (int k = 0; k < histCount; k++) {
    if (k) j += ",";
    j += sampleRow(hist[(start + k) % HIST_N]);
  }
  j += "]}";
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", j);
}

// ---------------------------------------------------------------------------
//  Commands – shared by the local web server and the cloud link
// ---------------------------------------------------------------------------

Args webArgs() { Args a; for (int i = 0; i < server.args(); i++) a.m[server.argName(i)] = server.arg(i); return a; }
void sendResult(const Result &r) {
  server.send(r.ok ? 200 : 400, "application/json", String("{\"ok\":") + (r.ok ? "true" : "false") + ",\"msg\":" + jstr(r.msg) + "}");
}

Result applySettings(const Args &A) {
  auto f = [&](const char *k, float &v, float lo, float hi) { if (A.has(k)) v = constrain(A.arg(k).toFloat(), lo, hi); };
  auto u8 = [&](const char *k, uint8_t &v, int lo, int hi) { if (A.has(k)) v = constrain(A.arg(k).toInt(), lo, hi); };
  auto u16 = [&](const char *k, uint16_t &v, int lo, int hi) { if (A.has(k)) v = constrain(A.arg(k).toInt(), lo, hi); };
  auto b = [&](const char *k, bool &v) { if (A.has(k)) v = A.arg(k) == "1" || A.arg(k) == "true"; };
  u8("crop", cfg.crop, 0, 3);
  f("startPct", cfg.startPct, 5, 90); f("targetPct", cfg.targetPct, 10, 95); f("criticalPct", cfg.criticalPct, 0, 80);
  u8("minSpeed", cfg.minSpeed, 20, 100);
  u16("pulseRunSec", cfg.pulseRunSec, 30, 3600); u16("soakSec", cfg.soakSec, 0, 3600);
  b("useWindows", cfg.useWindows);
  u8("w1Start", cfg.w1Start, 0, 23); u8("w1End", cfg.w1End, 0, 24); u8("w2Start", cfg.w2Start, 0, 23); u8("w2End", cfg.w2End, 0, 24);
  f("batCutoffV", cfg.batCutoffV, 9, 14); f("batResumeV", cfg.batResumeV, 9, 15);
  u16("manualMaxMin", cfg.manualMaxMin, 1, 120);
  f("pumpLpm", cfg.pumpLpm, 0.1, 200); f("dailyLimitL", cfg.dailyLimitL, 1, 100000);
  b("hotBoost", cfg.hotBoost); u8("noRiseMin", cfg.noRiseMin, 2, 60);
  u8("sensorCount", cfg.sensorCount, 1, 3);
  if (cfg.targetPct <= cfg.startPct + 5) cfg.targetPct = cfg.startPct + 5;     // keep a hysteresis band
  if (cfg.criticalPct >= cfg.startPct) cfg.criticalPct = cfg.startPct - 5;
  if (cfg.batResumeV <= cfg.batCutoffV) cfg.batResumeV = cfg.batCutoffV + 0.4f;
  saveSettings();
  addLog('i', "Settings saved");
  return {true, "Settings saved"};
}

Result runCommand(const Args &A) {
  String d = A.arg("do");
  if (d == "settings") return applySettings(A);
  if (d == "mode") {
    mode = A.arg("value") == "manual" ? MODE_MANUAL : MODE_AUTO;
    aState = ST_IDLE; holdEndMs = 0;
    addLog('i', String("Mode set to ") + (mode == MODE_AUTO ? "AUTO" : "MANUAL"));
    return {true, "Mode changed"};
  }
  if (d == "run") {
    if (lowBattery) return {false, "Battery is low. The pump is locked out to protect the battery."};
    int sp = constrain(A.arg("speed").toInt(), 30, 100);
    int mins = constrain(A.arg("minutes").toInt(), 1, (int)cfg.manualMaxMin);
    manualSpeed = sp; manualEndMs = millis() + mins * 60000UL; holdEndMs = 0;
    addLog('i', "Manual run " + String(mins) + " min at " + String(sp) + "%");
    return {true, "Pump started"};
  }
  if (d == "stop") {
    bool wasRunning = pumpTarget > 0;
    manualEndMs = 0;
    if (mode == MODE_AUTO && wasRunning) { holdEndMs = millis() + 30UL * 60000UL; aState = ST_IDLE; }
    addLog('i', "Pump stopped by user");
    return {true, "Pump stopped"};
  }
  if (d == "resume") { holdEndMs = 0; addLog('i', "Auto resumed"); return {true, "Auto resumed"}; }
  if (d == "clearAlarm") { alarm = ""; runSecSinceRise = 0; addLog('i', "Alarm reset by user"); return {true, "Alarm reset"}; }
  if (d == "time") {
    uint32_t ep = A.arg("epoch").toInt();
    if (ep > 1700000000) { struct timeval tv = {(time_t)ep, 0}; settimeofday(&tv, nullptr); }
    if (A.has("tz")) cfg.tzMin = A.arg("tz").toInt();
    return {true, "Clock set"};
  }
  if (d == "tracker") {
    trackerManual = A.arg("manual") == "1";
    if (A.has("angle")) trackerManualAngle = constrain(A.arg("angle").toFloat(), 0, 180);
    lastTrackMs = 0;
    return {true, "Tracker updated"};
  }
  if (d == "calibrate") {
    int i = constrain(A.arg("sensor").toInt(), 0, 2);
    int raw = readAvg(soilPins[i], 64);
    if (A.arg("point") == "dry") cfg.dryRaw[i] = raw; else cfg.wetRaw[i] = raw;
    saveSettings();
    addLog('i', "Sensor " + String(i + 1) + " " + A.arg("point") + " point = " + String(raw));
    return {true, "Calibration saved (" + String(raw) + ")"};
  }
  return {false, "Unknown command"};
}

void handleCmd() { sendResult(runCommand(webArgs())); }
void handleSettings() { sendResult(applySettings(webArgs())); }

void handleWifi() {
  prefs.begin("wifi", false);
  prefs.putString("ssid", server.arg("ssid"));
  prefs.putString("pass", server.arg("pass"));
  prefs.end();
  sendResult({true, "Saved. The controller restarts and joins the network."});
  delay(500); ESP.restart();
}

#include "cloud.h"   // optional Firebase link (CLOUD_ENABLED in config.h)

// ---------------------------------------------------------------------------
//  Setup / loop
// ---------------------------------------------------------------------------
void setupWifi() {
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  prefs.begin("wifi", true);
  String ssid = prefs.getString("ssid", STA_SSID), pass = prefs.getString("pass", STA_PASSWORD);
  prefs.end();
  if (ssid.length()) {
    WiFi.begin(ssid.c_str(), pass.c_str());
    uint32_t t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < 10000) delay(250);
    if (WiFi.status() == WL_CONNECTED) {
      addLog('i', "Joined Wi-Fi " + ssid + " as " + WiFi.localIP().toString());
      configTime(0, 0, "pool.ntp.org", "time.google.com");
    } else addLog('w', "Could not join Wi-Fi " + ssid);
  }
  MDNS.begin(MDNS_NAME);
  addLog('i', "Hotspot " AP_SSID " at " + WiFi.softAPIP().toString());
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_PUMP_A, OUTPUT); digitalWrite(PIN_PUMP_A, HIGH);
  pinMode(PIN_PUMP_B, OUTPUT); digitalWrite(PIN_PUMP_B, LOW);
  pinMode(PIN_STATUS_LED, OUTPUT);
  pwmInit(); writePump(0); writeServo(90);
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);
  for (int i = 0; i < 3; i++) soil[i] = {0, NAN, false};
  loadSettings();
  dht.begin();
  dayStartMs = millis();
  addLog('i', "Controller started (fw " FW_VERSION ")");
  setupWifi();

  if (!LittleFS.begin(true)) addLog('e', "LittleFS mount failed");
  server.on("/api/status", HTTP_GET, handleStatus);
  server.on("/api/history", HTTP_GET, handleHistory);
  server.on("/api/cmd", HTTP_POST, handleCmd);
  server.on("/api/settings", HTTP_POST, handleSettings);
  server.on("/api/wifi", HTTP_POST, handleWifi);
  server.serveStatic("/css", LittleFS, "/css", "no-cache");
  server.serveStatic("/js", LittleFS, "/js", "no-cache");
  server.on("/", HTTP_GET, []() {
    File f = LittleFS.open("/index.html", "r");
    if (!f) { server.send(404, "text/html", "<h2>Dashboard file not found</h2><p>Upload the <b>data</b> folder to LittleFS (see README). "
                                            "The API is running: <a href='/api/status'>/api/status</a></p>"); return; }
    server.sendHeader("Cache-Control", "no-cache");
    server.streamFile(f, "text/html");
    f.close();
  });
  server.onNotFound([]() {
    server.sendHeader("Location", "/");   // captive-portal style: send everything to the dashboard
    server.send(302, "text/plain", "");
  });
  server.begin();
  MDNS.addService("http", "tcp", 80);
  cloudBegin();
}

uint32_t lastCtrlMs = 0, lastSensMs = 0;
void loop() {
  server.handleClient();
  uint32_t now = millis();
  if (now - lastSensMs >= 1000) {       // sensors every second
    float dt = (now - lastSensMs) / 1000.0f; if (!lastSensMs) dt = 1;
    lastSensMs = now;
    readSoil(); readAir(); readPower();
    totalsLoop(dt);
    trackerLoop();
  }
  if (now - lastCtrlMs >= 100) {        // control + soft start every 100 ms
    float dt = (now - lastCtrlMs) / 1000.0f; if (!lastCtrlMs) dt = 0.1f;
    lastCtrlMs = now;
    controlLoop(dt);
  }
  cloudLoop();
}
