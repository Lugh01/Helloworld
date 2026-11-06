# Solar Irrigation Dashboard – web folder

The IoT website for the solar-tracking irrigation project, split into separate files for editing.

```
web/
├── index.html        page structure (tabs: Overview, Tracker & sensors, Setup, User guide)
├── css/style.css     all styling, light and dark theme colours at the top
├── js/cloud-config.js  Firebase keys for viewing from anywhere (see main README, section 7)
├── js/data.js        talks to the ESP32 API, the Firebase cloud, and the demo simulator
├── js/app.js         renders gauges, tiles, charts, buttons and settings
└── mock-server.js    fake ESP32 for testing "Live" mode on your computer
```

## Test it in Antigravity (or VS Code)

**Option 1: demo mode (simplest)**
Open `index.html` in a browser (right-click → *Open in browser*, or the Live Server / Live Preview extension). The pill at the top right shows **Demo data** and everything runs on simulated sensors.

**Option 2: live mode with the mock controller (recommended for testing)**
Open the terminal in Antigravity, then run:
```
cd web
node mock-server.js
```
Open **http://localhost:8080**. The pill shows **Live**: the page now uses the real API (`/api/status`, `/api/cmd`, ...) exactly as on the ESP32. Pressing *Run pump*, changing mode or saving settings prints the command in the terminal.
Needs Node.js 18 or newer: https://nodejs.org

## Put your changes on the ESP32

Copy `index.html`, `css/` and `js/` into `firmware/SolarIrrigation/data/` and upload LittleFS again (see the main README).

## Put it online (free)

Pushing to `main` publishes this folder with GitHub Pages: https://lugh01.github.io/Helloworld/ (one-time setup in the main README, section 7). Add `?demo` to the address to see simulated data without signing in.
