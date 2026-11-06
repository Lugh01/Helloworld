// ============================================================================
//  Optional cloud link: Firebase Realtime Database (free "Spark" plan)
//
//  Database layout under /<FB_DEVICE_PATH>/
//    status       live status (same JSON as /api/status) + "seen" server time
//    history/N    24 h ring buffer, N = 0..287, one row every 5 minutes
//    commands/*   commands written by the dashboard, deleted once executed
//    lastResult   result of the last executed command {key, ok, msg}
//
//  The network work runs in its own FreeRTOS task on core 0, so slow HTTPS
//  requests never delay the pump control loop. Commands are handed to the
//  main loop through a mutex-protected queue and executed there.
// ============================================================================
#pragma once

#if CLOUD_ENABLED
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <vector>

static SemaphoreHandle_t cloudMux;
static String cloudStatusBody;                         // newest status JSON (from loop)
static std::vector<std::pair<int, String>> cloudSamples; // history rows to upload
static std::vector<std::pair<String, Args>> cloudCmds; // received, waiting for loop()
static std::vector<std::pair<String, Result>> cloudResults;
static String fbToken;
static uint32_t fbTokenMs = 0, cloudLastStatusBuild = 0;

static bool fbRequest(const char *method, const String &url, const String &body, String *out) {
  WiFiClientSecure client;
  client.setInsecure();   // simple for a prototype; pin Google's root CA for production
  HTTPClient http;
  http.setTimeout(10000);
  if (!http.begin(client, url)) return false;
  http.addHeader("Content-Type", "application/json");
  int code = http.sendRequest(method, (uint8_t *)body.c_str(), body.length());
  if (out) *out = http.getString();
  http.end();
  if (code == 401) fbToken = "";   // token expired: sign in again
  return code >= 200 && code < 300;
}

static String fbUrl(const String &path) {
  return String(FB_DATABASE_URL) + "/" + FB_DEVICE_PATH + path + ".json?auth=" + fbToken;
}

static bool fbSignIn() {
  String out;
  String body = String("{\"email\":") + jstr(FB_EMAIL) + ",\"password\":" + jstr(FB_PASSWORD) + ",\"returnSecureToken\":true}";
  if (!fbRequest("POST", String("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=") + FB_API_KEY, body, &out)) {
    Serial.println("[cloud] sign-in failed: " + out);
    return false;
  }
  JsonDocument d;
  if (deserializeJson(d, out)) return false;
  fbToken = d["idToken"] | "";
  fbTokenMs = millis();
  Serial.println("[cloud] signed in");
  return fbToken.length() > 0;
}

static String jsonValueToString(JsonVariantConst v) {
  if (v.is<const char *>()) return String(v.as<const char *>());
  String s; serializeJson(v, s); return s;
}

static void cloudTask(void *) {
  uint32_t lastStatus = 0, lastCmd = 0;
  bool wasOnline = false;
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(250));
    if (WiFi.status() != WL_CONNECTED || !timeValid()) continue;   // need internet + NTP time
    if (!fbToken.length() || millis() - fbTokenMs > 50UL * 60000UL) {
      if (!fbSignIn()) { vTaskDelay(pdMS_TO_TICKS(30000)); continue; }
    }

    // Take everything that loop() prepared
    std::vector<std::pair<String, Result>> results;
    std::vector<std::pair<int, String>> samples;
    String status;
    xSemaphoreTake(cloudMux, portMAX_DELAY);
    results.swap(cloudResults); samples.swap(cloudSamples); status = cloudStatusBody;
    xSemaphoreGive(cloudMux);

    for (auto &r : results) {
      String b = "{\"key\":" + jstr(r.first) + ",\"ok\":" + (r.second.ok ? "true" : "false") + ",\"msg\":" + jstr(r.second.msg) + ",\"t\":{\".sv\":\"timestamp\"}}";
      fbRequest("PUT", fbUrl("/lastResult"), b, nullptr);
    }
    for (auto &s : samples) fbRequest("PUT", fbUrl("/history/" + String(s.first)), s.second, nullptr);

    if (status.length() && millis() - lastStatus >= CLOUD_STATUS_MS) {
      lastStatus = millis();
      String body = "{\"seen\":{\".sv\":\"timestamp\"}," + status.substring(1);
      bool ok = fbRequest("PUT", fbUrl("/status"), body, nullptr);
      if (ok != wasOnline) Serial.println(ok ? "[cloud] online" : "[cloud] upload failed");
      wasOnline = ok;
    }

    if (millis() - lastCmd >= CLOUD_CMD_MS) {
      lastCmd = millis();
      String out;
      if (fbRequest("GET", fbUrl("/commands"), "", &out) && out != "null") {
        JsonDocument d;
        if (!deserializeJson(d, out)) {
          for (JsonPairConst kv : d.as<JsonObjectConst>()) {
            String key = kv.key().c_str();
            JsonObjectConst o = kv.value().as<JsonObjectConst>();
            Args a;
            for (JsonPairConst p : o) if (String(p.key().c_str()) != "ts") a.m[p.key().c_str()] = jsonValueToString(p.value());
            // Safety: never execute stale commands (e.g. "run pump" sent hours ago while offline)
            int64_t ts = o["ts"] | (int64_t)0;
            bool fresh = ts > 0 && llabs(ts / 1000 - (int64_t)time(nullptr)) < 120;
            fbRequest("DELETE", fbUrl("/commands/" + key), "", nullptr);
            xSemaphoreTake(cloudMux, portMAX_DELAY);
            if (fresh) cloudCmds.push_back({key, a});
            else cloudResults.push_back({key, {false, "Command ignored: it was sent more than 2 minutes ago"}});
            xSemaphoreGive(cloudMux);
          }
        }
      }
    }
  }
}

void cloudBegin() {
  if (!strlen(FB_API_KEY) || !strlen(FB_DATABASE_URL)) { addLog('w', "Cloud enabled but not configured (config.h)"); return; }
  cloudMux = xSemaphoreCreateMutex();
  xTaskCreatePinnedToCore(cloudTask, "cloud", 16384, nullptr, 1, nullptr, 0);
  addLog('i', "Cloud link started");
}

// Called from loop(): prepare data for upload and execute received commands
void cloudLoop() {
  if (!cloudMux) return;
  std::vector<std::pair<String, Args>> cmds;
  xSemaphoreTake(cloudMux, portMAX_DELAY);
  cmds.swap(cloudCmds);
  xSemaphoreGive(cloudMux);

  std::vector<std::pair<String, Result>> res;
  for (auto &c : cmds) {
    addLog('i', "Cloud command: " + c.second.arg("do"));
    res.push_back({c.first, runCommand(c.second)});
  }

  String status;
  if (millis() - cloudLastStatusBuild >= 2000 || res.size()) { cloudLastStatusBuild = millis(); status = statusJson(); }
  int slot = newSampleSlot; newSampleSlot = -1;

  xSemaphoreTake(cloudMux, portMAX_DELAY);
  for (auto &r : res) cloudResults.push_back(r);
  if (status.length()) cloudStatusBody = status;
  if (slot >= 0) cloudSamples.push_back({slot, sampleRow(hist[slot])});
  xSemaphoreGive(cloudMux);
}

#else
void cloudBegin() {}
void cloudLoop() { newSampleSlot = -1; }
#endif
