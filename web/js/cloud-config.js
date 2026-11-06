// Cloud settings for viewing the farm from anywhere (free Firebase).
// Copy the values from Firebase console -> Project settings (gear icon) -> General.
// Leave apiKey empty to turn the cloud off (the page then shows demo data
// when it is not opened from the ESP32).
window.CLOUD_CONFIG = {
  apiKey: "",            // "Web API key", e.g. "AIzaSy..."
  databaseURL: "",       // Realtime Database URL, e.g. "https://my-farm-default-rtdb.asia-southeast1.firebasedatabase.app"
  devicePath: "farm1"    // must match FB_DEVICE_PATH in firmware config.h
};
