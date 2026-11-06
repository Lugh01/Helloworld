# Solar-Tracking Smart Irrigation – IoT Controller

IoT dashboard and ESP32 firmware for the project **"Development of an Automated Solar-Tracking Irrigation System for Sustainable Agriculture in Myanmar"** (University of Wolverhampton, Individual Innovation Project).

The ESP32 measures soil moisture, air temperature/humidity, battery and solar panel, waters the crop automatically with a speed-controlled DC pump, turns the solar panel to follow the sun, and serves a mobile-friendly web dashboard over its own Wi-Fi hotspot. **No internet is needed in the field.**

```
firmware/SolarIrrigation/
├── SolarIrrigation.ino   ← controller logic, sensors, pump, tracker, web API
├── config.h              ← pins, Wi-Fi name/password, divider ratios (edit this)
└── data/index.html       ← the dashboard (served by the ESP32 from LittleFS)
```

Open `firmware/SolarIrrigation/data/index.html` straight in a browser to see the dashboard in **demo mode** with simulated data. This needs no hardware.

---

## 1. Why this architecture

| Choice | Reason |
|---|---|
| **ESP32 hosts the website itself** (hotspot `SolarIrrigation`, `http://192.168.4.1`) | Farms in the Central Dry Zone often have no reliable internet. There's no cloud account, monthly fee, or outage risk. |
| **Single-file dashboard, no external libraries** | Loads instantly from the ESP32 even without internet. Works on any phone browser. |
| **Control decisions run on the ESP32, not in the browser** | The field keeps being watered when no phone is connected. The website monitors, sets the parameters, and gives a manual override. |
| **Optional router connection** (Setup → Wi-Fi) | When a router is available, the clock syncs from the internet and the dashboard can be reached from the home network. |
| **Simple JSON API** | The same API can later feed ThingSpeak, Blynk, Node-RED or a cloud database if you need remote access from anywhere. |

---

## 2. Recommended control strategy (implemented in the firmware)

The proposal asks for the pump speed to follow the soil's water need. The controller does this as a closed loop with **hysteresis, proportional speed, and pulse-and-soak cycles**:

1. **Measure:** read every soil sensor once a second (16-sample average plus smoothing). Ignore any sensor that is disconnected or shorted, and average the valid ones. One failed sensor cannot flood or starve the plot.
2. **Hysteresis band:** start watering when the average falls **below the start level** (tomato 45 %). Stop at the **target level** (tomato 70 %). The gap between them keeps the pump from switching on and off all the time.
3. **Proportional speed:**
   `speed = minSpeed + (target − moisture) / (target − critical) × (100 − minSpeed)`.
   Very dry soil gets 100 %. Nearly-wet soil gets about 45 %. This saves battery and avoids high pressure and runoff, as described in the proposal ("low moisture → max speed, moderate → low speed, optimal → stop").
4. **Pulse and soak:** run at most 5 min, then pause 10 min so water reaches the root zone before the sensor reads again. This prevents overshoot, because the sensor responds slowly, and improves infiltration in dry-zone soils.
5. **Watering windows:** water preferably 05–09 h and 16–19 h, when evaporation is lowest. If the soil drops below the **critical** level it is watered at any time.
6. **Hot-day boost:** if the DHT22 reads more than 35 °C, the target rises by 5 %.
7. **Soft start:** the PWM ramps up to protect the pump, the driver and the battery from inrush current.

**Protections**

- **Battery cut-off:** the pump is blocked below 11.6 V and allowed again above 12.3 V. Manual runs can't override this.
- **Dry-run alarm:** if the pump runs for 8 minutes without the soil getting 2 % wetter, it stops and raises an alarm (empty tank, blocked pipe, sensor out of soil).
- **Daily water limit:** auto watering stops after 400 L/day (adjustable).
- **Manual runs are always timed** (max 15 min by default) and stop if the soil is saturated.
- **Manual stop in Auto mode** pauses auto watering for 30 min, so the system doesn't immediately restart the pump the user just stopped.

**Crop presets** (percentage of the calibrated sensor range; fine-tune in the field):

| Crop | Start below | Stop at | Critical | Sensor depth |
|---|---|---|---|---|
| Tomato | 45 % | 70 % | 30 % | 10–15 cm |
| Chili | 40 % | 65 % | 28 % | 10–15 cm |
| Onion | 50 % | 75 % | 35 % | 5–10 cm |

**Solar tracker:** time-based single axis. The angle runs linearly from 15° at 06:00 to 165° at 18:00, and the servo moves every 15 minutes. Overnight the panel parks facing east. Time comes from NTP (if a router is joined) or from the phone (the dashboard sets the ESP32 clock automatically when it connects).

> **Note on the proposal:** Section 4 says the IoT platform "will only monitor the irrigation system". This dashboard keeps automatic control on the ESP32 as the default (Auto mode), and adds a manual **Run pump** button with safety limits for testing, flushing pipes and sensor failures. If your examiner wants monitoring only, delete the pump card's `#pumpBtn` and the mode buttons in `index.html`, or ignore the `run`/`mode` commands in `handleCmd()`.

---

## 3. Hardware and wiring

| Component | ESP32 pin | Notes |
|---|---|---|
| Capacitive soil sensor 1 / 2 / 3 (AOUT) | GPIO 34 / 35 / 32 | Power from 3.3 V. ADC1 pins only (ADC2 doesn't work with Wi-Fi on). |
| DHT22 data | GPIO 4 | 10 kΩ pull-up to 3.3 V |
| Battery voltage divider | GPIO 36 (VP) | 100 kΩ (top) / 22 kΩ (bottom) → up to 18 V |
| Solar panel voltage divider | GPIO 39 (VN) | 100 kΩ / 15 kΩ → up to 25 V |
| ACS712 current sensor (optional) | GPIO 33 | 5 V module: put a 10 kΩ / 20 kΩ divider on its output |
| Motor driver PWM (IBT-2 RPWM or L298N ENA) | GPIO 25 | 20 kHz for IBT-2. Set `PUMP_PWM_FREQ 1000` for L298N. |
| Driver enable (IBT-2 R_EN+L_EN, or L298N IN1) | GPIO 26 | held HIGH |
| IBT-2 LPWM or L298N IN2 | GPIO 27 | held LOW |
| Tracker servo signal | GPIO 13 | Power the servo from its own 5–6 V buck converter, not from the ESP32. |
| Status LED | GPIO 2 | On while the pump runs |

Power: 12 V battery → solar charge controller → 12 V pump via the motor driver. A 12 V→5 V buck converter feeds the ESP32 (VIN) and the servo. All grounds connect together. Use an **IBT-2 (BTS7960)** rather than an L298N if possible: the L298N wastes about 2 V as heat.

Calibrate the voltage dividers: measure the battery with a multimeter and adjust `BAT_DIVIDER` in `config.h` until the dashboard matches.

---

## 4. Install

1. Install **Arduino IDE 2** and the **esp32 by Espressif** board package (2.x or 3.x).
2. Library Manager: install **DHT sensor library** (Adafruit) and **Adafruit Unified Sensor**.
3. Open `firmware/SolarIrrigation/SolarIrrigation.ino`. Edit `config.h` (change `AP_PASSWORD`!).
4. Board: **ESP32 Dev Module**. Partition scheme: **Default 4MB with spiffs**. Upload.
5. Upload the dashboard into LittleFS: install the [arduino-littlefs-upload](https://github.com/earlephilhower/arduino-littlefs-upload) plugin. Then press `Ctrl+Shift+P` → **Upload LittleFS to Pico/ESP8266/ESP32** (close the Serial Monitor first).
   *(PlatformIO: put `data/` next to `platformio.ini`, set `board_build.filesystem = littlefs`, run `pio run -t uploadfs`.)*
6. On your phone, join Wi-Fi **SolarIrrigation** and open **http://192.168.4.1** (or `http://irrigation.local`).

On first use: choose the crop (**Setup**), calibrate each soil sensor (**Tracker & sensors** → *Save as dry* in air, *Save as wet* in water), and measure the pump flow with a bucket and a timer. Enter that in *Pump flow at full speed*.

---

## 5. Dashboard

- **Overview:** soil moisture gauge with the crop's start and target band, per-sensor bars, a big **Run / Stop pump** button with speed and run-time selection, and an Auto/Manual switch. Tiles show air temperature, humidity, battery (V and %), solar power (W, V, A), panel angle and water used today. There are 24-hour charts (soil & pump, air, power) and an activity log.
- **Tracker & sensors:** sun-path view of the panel, automatic or manual angle, sensor calibration table, system info, alarm reset, clock sync, and Wi-Fi router setup.
- **Setup:** crop profile, moisture thresholds, pump behaviour, watering hours, battery limits, dry-run alarm and number of sensors. All settings are saved in ESP32 flash.
- **User guide:** a farmer-friendly explanation of every reading, how auto watering works, what each alert means and what to do, normal ranges, and maintenance.

### JSON API

| Method | Path | Parameters | Purpose |
|---|---|---|---|
| GET | `/api/status` | — | all live readings, pump state, settings, last 25 events |
| GET | `/api/history` | — | 24 h at 5-min intervals: `[epoch, soil×10, temp×10, hum×10, batV×100, solarW×10, pump%]` |
| POST | `/api/cmd` | `do=mode&value=auto\|manual` | change mode |
| POST | `/api/cmd` | `do=run&speed=30..100&minutes=1..N` | timed manual run |
| POST | `/api/cmd` | `do=stop` / `do=resume` / `do=clearAlarm` | stop pump / resume auto / reset alarm |
| POST | `/api/cmd` | `do=tracker&manual=0\|1&angle=0..180` | tracker control |
| POST | `/api/cmd` | `do=calibrate&sensor=0..2&point=dry\|wet` | store calibration point |
| POST | `/api/cmd` | `do=time&epoch=…&tz=minutes` | set clock |
| POST | `/api/settings` | any setting field | save settings |
| POST | `/api/wifi` | `ssid`, `pass` | join a router (restarts) |

Example: `curl -X POST -d "do=run&speed=70&minutes=5" http://192.168.4.1/api/cmd`

---

## 6. Data for your report (Phase 4–5 testing)

The dashboard records everything needed for the performance evaluation: soil moisture response to watering, pump run time, **litres used per day** (from measured flow × speed × time), **solar energy harvested (Wh/day)**, battery voltage over the day and night, and panel angle against solar power, which shows the tracking gain. To compare tracking with a fixed panel, set the tracker to *Manual angle* at 90° for a day and compare the daily Wh.
