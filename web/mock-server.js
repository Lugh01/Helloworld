// Mock ESP32 controller for testing the dashboard in "Live" mode on your computer.
// It serves this folder and answers the same /api/... requests as the real ESP32,
// using the simulator from js/data.js.
//
//   node mock-server.js        then open http://localhost:8080
//
// Requires Node.js 18+ (no npm packages needed).
const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

// Load the simulator from the browser code
const ctx = { console, Date, Math, JSON, URLSearchParams, setTimeout, clearTimeout };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, "js/data.js"), "utf8") + "\nthis.Sim = Sim;", ctx);
const sim = new ctx.Sim();
// Report live data as the ESP32 would (no demo label)
const status = async () => { const s = await sim.status(); s.fw = "1.0.0-mock"; return s; };

const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

function readBody(req) {
  return new Promise(res => { let b = ""; req.on("data", c => b += c); req.on("end", () => res(Object.fromEntries(new URLSearchParams(b)))); });
}
function json(res, code, obj) { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); }

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/status") return json(res, 200, await status());
    if (url.pathname === "/api/history") return json(res, 200, await sim.history());
    if (req.method === "POST" && url.pathname === "/api/cmd") {
      const p = await readBody(req);
      console.log("cmd", p);
      try { return json(res, 200, await sim.cmd(p)); } catch (e) { return json(res, 400, { ok: false, msg: e.message }); }
    }
    if (req.method === "POST" && url.pathname === "/api/settings") { const p = await readBody(req); console.log("settings", p); return json(res, 200, await sim.saveSettings(p)); }
    if (req.method === "POST" && url.pathname === "/api/wifi") return json(res, 200, { ok: true, msg: "Mock: Wi-Fi settings received" });

    let file = path.normalize(path.join(ROOT, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) { console.error(e); json(res, 500, { ok: false, msg: String(e) }); }
}).listen(PORT, () => console.log(`Mock controller running: http://localhost:${PORT}`));
