"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target2) => (target2 = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target2, "default", { value: mod, enumerable: true }) : target2,
  mod
));

// src/hub/main.ts
var import_electron3 = require("electron");
var import_node_net = __toESM(require("node:net"), 1);
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_path2 = __toESM(require("node:path"), 1);

// src/shared/protocol.ts
var import_node_os = require("node:os");
var import_node_path = require("node:path");
var HUB_DIR = (0, import_node_path.join)((0, import_node_os.homedir)(), "Library", "Application Support", "screen-buddy");
var SOCKET_PATH = (0, import_node_path.join)(HUB_DIR, "hub.sock");
var LOG_PATH = (0, import_node_path.join)(HUB_DIR, "hub.log");

// src/hub/capture.ts
var import_electron = require("electron");
function toGlobal(t, x, y) {
  return { x: t.ox + x * t.sx, y: t.oy + y * t.sy };
}
function toImage(t, gx, gy) {
  return { x: (gx - t.ox) / t.sx, y: (gy - t.oy) / t.sy };
}
var PermissionError = class extends Error {
};
var queue = Promise.resolve();
function getSources(opts) {
  const run = () => Promise.race([
    import_electron.desktopCapturer.getSources(opts),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Screen capture timed out")), 5e3))
  ]);
  const p = queue.then(run, run);
  queue = p.catch(() => {
  });
  return p;
}
function permissionHint() {
  return 'Screen Recording permission is missing for the buddy hub (it shows up as "Electron"). Open System Settings > Privacy & Security > Screen Recording, turn on Electron, then try again (macOS may ask you to quit and reopen it: call deactivate, then activate).';
}
async function grab(display, thumb) {
  const size = thumb ?? {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor)
  };
  let sources;
  try {
    sources = await getSources({ types: ["screen"], thumbnailSize: size });
  } catch (e) {
    if (e instanceof Error && /timed out/.test(e.message)) throw e;
    throw new PermissionError(`${permissionHint()} (status: ${import_electron.systemPreferences.getMediaAccessStatus("screen")}; ${e})`);
  }
  const src = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : void 0);
  const status = import_electron.systemPreferences.getMediaAccessStatus("screen");
  if (!src || src.thumbnail.isEmpty() || status === "denied" || status === "restricted") {
    throw new PermissionError(permissionHint());
  }
  return src.thumbnail;
}
function fitTo(img, maxDim, minDim = 0) {
  const { width, height } = img.getSize();
  const long = Math.max(width, height);
  const target2 = Math.max(Math.min(long, maxDim), Math.min(minDim, maxDim));
  if (target2 === long) return img;
  const k = target2 / long;
  return img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: "best" });
}
function encode(img) {
  const { width, height } = img.getSize();
  return { data: img.toJPEG(72).toString("base64"), width, height };
}
function findMarker(img, ex, ey, radius) {
  const { width, height } = img.getSize();
  const bmp = img.toBitmap();
  let sx = 0, sy = 0, n = 0;
  const x0 = Math.max(0, Math.round(ex - radius)), x1 = Math.min(width - 1, Math.round(ex + radius));
  const y0 = Math.max(0, Math.round(ey - radius)), y1 = Math.min(height - 1, Math.round(ey + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * width + x) * 4;
      const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
      if (r > 190 && b > 190 && g < 100) {
        sx += x;
        sy += y;
        n++;
      }
    }
  }
  return n > 20 ? { x: sx / n, y: sy / n, pixels: n } : void 0;
}

// src/hub/frames.ts
var import_electron2 = require("electron");
var FRAME_WIDTH = 640;
var PIXEL_DELTA = 28;
var EDGE_DELTA = 36;
var FILL_DELTA = 64;
var BLOCK = 8;
function toFrame(img, displayId, bounds) {
  const { width: w, height: h } = img.getSize();
  const bmp = img.toBitmap();
  const grey = new Uint8Array(w * h);
  for (let i = 0; i < grey.length; i++) grey[i] = bmp[i * 4] * 29 + bmp[i * 4 + 1] * 150 + bmp[i * 4 + 2] * 77 >> 8;
  return { displayId, bounds, w, h, grey, at: Date.now() };
}
async function sampleFrames() {
  const sources = await getSources({ types: ["screen"], thumbnailSize: { width: FRAME_WIDTH, height: FRAME_WIDTH } });
  const out = /* @__PURE__ */ new Map();
  for (const s of sources) {
    const d = import_electron2.screen.getAllDisplays().find((x) => String(x.id) === s.display_id);
    if (d && !s.thumbnail.isEmpty()) out.set(d.id, toFrame(s.thumbnail, d.id, d.bounds));
  }
  return out;
}
function cellRange(f, r) {
  if (!r) return { x0: 0, y0: 0, x1: f.w, y1: f.h };
  const kx = f.w / f.bounds.width, ky = f.h / f.bounds.height;
  return {
    x0: Math.max(0, Math.floor((r.x - f.bounds.x) * kx)),
    y0: Math.max(0, Math.floor((r.y - f.bounds.y) * ky)),
    x1: Math.min(f.w, Math.ceil((r.x + r.width - f.bounds.x) * kx)),
    y1: Math.min(f.h, Math.ceil((r.y + r.height - f.bounds.y) * ky))
  };
}
function compare(a, b, region, changed) {
  if (a.displayId !== b.displayId || a.w !== b.w || a.h !== b.h) {
    return { fraction: 1, blocks: Infinity, blockFraction: 1, bbox: region ?? b.bounds };
  }
  const { x0, y0, x1, y1 } = cellRange(b, region);
  const bw = Math.ceil((x1 - x0) / BLOCK), bh = Math.ceil((y1 - y0) / BLOCK);
  if (bw <= 0 || bh <= 0) return { fraction: 0, blocks: 0, blockFraction: 0 };
  const perBlock = new Uint16Array(bw * bh);
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (changed(y * b.w + x)) {
        n++;
        perBlock[Math.floor((y - y0) / BLOCK) * bw + Math.floor((x - x0) / BLOCK)]++;
      }
    }
  }
  let blocks = 0, bx0 = Infinity, by0 = Infinity, bx1 = -1, by1 = -1;
  for (let j = 0; j < bh; j++) {
    for (let i = 0; i < bw; i++) {
      if (perBlock[j * bw + i] < 3) continue;
      blocks++;
      bx0 = Math.min(bx0, i);
      by0 = Math.min(by0, j);
      bx1 = Math.max(bx1, i);
      by1 = Math.max(by1, j);
    }
  }
  const sx = b.bounds.width / b.w, sy = b.bounds.height / b.h;
  const bbox = blocks ? {
    x: b.bounds.x + (x0 + bx0 * BLOCK) * sx,
    y: b.bounds.y + (y0 + by0 * BLOCK) * sy,
    width: Math.min(x1 - x0, (bx1 - bx0 + 1) * BLOCK) * sx,
    height: Math.min(y1 - y0, (by1 - by0 + 1) * BLOCK) * sy
  } : void 0;
  return { fraction: n / ((x1 - x0) * (y1 - y0)), blocks, blockFraction: blocks / (bw * bh), bbox };
}
function pixelDiff(a, b, region) {
  return compare(a, b, region, (i) => Math.abs(a.grey[i] - b.grey[i]) > PIXEL_DELTA);
}
function layoutDiff(a, b, region) {
  const w = b.w;
  return compare(a, b, region, (i) => {
    if (Math.abs(a.grey[i] - b.grey[i]) > FILL_DELTA) return true;
    if (i % w === w - 1 || i + w >= a.grey.length) return false;
    const ea = Math.abs(a.grey[i + 1] - a.grey[i]) + Math.abs(a.grey[i + w] - a.grey[i]);
    const eb = Math.abs(b.grey[i + 1] - b.grey[i]) + Math.abs(b.grey[i + w] - b.grey[i]);
    return Math.abs(ea - eb) > EDGE_DELTA;
  });
}
function around(x, y, r) {
  return { x: x - r, y: y - r, width: 2 * r, height: 2 * r };
}

// src/hub/main.ts
var SHOW_IN_CAPTURE = process.argv.includes("--show-in-capture");
var SHORTCUT = process.env.SWH_SHORTCUT || "Alt+Shift+Space";
var IDLE_QUIT_MS = Number(process.env.SCREEN_BUDDY_IDLE_MS || 3e4);
var RENDERER_DIR = import_node_path2.default.join(__dirname, "..", "..", "overlay");
var TARGET_RADIUS = 40;
var MAX_SHOTS = 6;
import_node_fs.default.mkdirSync(HUB_DIR, { recursive: true });
function log(...parts) {
  const line = parts.map((p) => p instanceof Error ? p.stack : typeof p === "string" ? p : JSON.stringify(p)).join(" ");
  try {
    import_node_fs.default.appendFileSync(LOG_PATH, `${(/* @__PURE__ */ new Date()).toISOString()} ${line}
`);
  } catch {
  }
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
import_electron3.app.setName("screen-buddy");
import_electron3.app.setPath("userData", import_node_path2.default.join(HUB_DIR, "electron"));
var isHub = import_electron3.app.requestSingleInstanceLock();
if (!isHub) {
  log("another hub is running; exiting");
  import_electron3.app.exit(0);
}
import_electron3.app.dock?.hide();
var buddies = /* @__PURE__ */ new Map();
var nextBuddyId = 1;
function touch(b) {
  b.lastActive = Date.now();
}
function enqueue(b, e) {
  if (b.waiter) return b.waiter(e);
  if (e.type === "screen_changed" && b.queue.some((q) => q.type === "screen_changed")) return;
  b.queue.push(e);
}
function removeBuddy(b, why) {
  if (!buddies.delete(b.id)) return;
  log(`buddy ${b.id} (${b.name}) left: ${why}`);
  b.waiter?.(null);
  for (const s of surfaces.values()) send(s, "clear-buddy", { id: b.id });
  render();
  scheduleIdleQuit();
}
var surfaces = /* @__PURE__ */ new Map();
function orderedDisplays() {
  const primary = import_electron3.screen.getPrimaryDisplay();
  const rest = import_electron3.screen.getAllDisplays().filter((d) => d.id !== primary.id);
  return [primary, ...rest.sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)];
}
var displayIndex = (id) => orderedDisplays().findIndex((d) => d.id === id) + 1;
var displayById = (id) => import_electron3.screen.getAllDisplays().find((d) => d.id === id);
var displayAt = (x, y) => import_electron3.screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
function createSurface(display) {
  const { x, y, width, height } = display.bounds;
  const win = new import_electron3.BrowserWindow({
    x,
    y,
    width,
    height,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    enableLargerThanScreen: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: { preload: import_node_path2.default.join(RENDERER_DIR, "preload.cjs") }
  });
  win.setBounds({ x, y, width, height });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setContentProtection(!SHOW_IN_CAPTURE);
  const s = { win, display, ready: false };
  win.webContents.on("did-finish-load", () => {
    s.ready = true;
    win.showInactive();
    send(s, "init", { shortcut: SHORTCUT });
    render();
  });
  win.loadFile(import_node_path2.default.join(RENDERER_DIR, "overlay.html"));
  surfaces.set(display.id, s);
}
var rebuildTimer;
function rebuildSurfaces() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    for (const s of surfaces.values()) s.win.destroy();
    surfaces.clear();
    for (const d of orderedDisplays()) createSurface(d);
    for (const b of buddies.values()) if (!displayById(b.displayId)) retreat(b);
    log("displays changed", orderedDisplays().map((d) => d.bounds));
  }, 300);
}
function send(s, channel, data) {
  if (s?.ready && !s.win.isDestroyed()) s.win.webContents.send(channel, data);
}
var sendAll = (channel, data) => surfaces.forEach((s) => send(s, channel, data));
var displayOf = (b) => b.mode === "home" ? import_electron3.screen.getPrimaryDisplay().id : b.displayId;
var surfaceFor = (b) => surfaces.get(displayOf(b)) ?? surfaces.get(import_electron3.screen.getPrimaryDisplay().id);
var surfaceOf = (wc) => [...surfaces.values()].find((s) => s.win.webContents === wc);
function target(b) {
  if (b.mode === "point") return { x: b.gx, y: b.gy };
  const s = surfaces.get(import_electron3.screen.getPrimaryDisplay().id);
  const bounds = s?.win.getBounds() ?? import_electron3.screen.getPrimaryDisplay().bounds;
  const docked = [...buddies.values()].sort((a, c) => a.id - c.id);
  const i = docked.indexOf(b);
  return { x: bounds.x + bounds.width - 46 - i * 58, y: bounds.y + bounds.height - 50 };
}
function render() {
  for (const s of surfaces.values()) {
    const wb = s.win.getBounds();
    const list = [...buddies.values()].filter((b) => surfaceFor(b) === s).map((b) => {
      const t = target(b);
      return { id: b.id, name: b.name, slot: b.slot, state: b.state, listening: b.listening, mode: b.mode, x: t.x - wb.x, y: t.y - wb.y };
    });
    send(s, "buddies", list);
  }
}
function setStatus(s, text) {
  const b = s;
  if (!buddies.has(b.id) || buddies.get(b.id) !== b || b.status === text) return;
  b.status = text;
  sendAll("status", { id: b.id, text: text ?? "" });
}
function showHighlight(b, h) {
  const s = surfaces.get(displayAt(h.gx + h.gw / 2, h.gy + h.gh / 2).id);
  if (!s) return;
  const wb = s.win.getBounds();
  send(s, "highlight", { id: b.id, slot: b.slot, x: h.gx - wb.x, y: h.gy - wb.y, w: h.gw, h: h.gh, label: h.label });
}
function retreat(b) {
  Object.assign(b, { mode: "home", label: void 0, highlights: [], anchor: void 0, parked: void 0 });
  if (b.state === "pointing") b.state = "idle";
  sendAll("clear-buddy", { id: b.id });
  render();
}
var latest = /* @__PURE__ */ new Map();
var lastFull;
var union = (a, c) => {
  const x = Math.min(a.x, c.x), y = Math.min(a.y, c.y);
  return { x, y, width: Math.max(a.x + a.width, c.x + c.width) - x, height: Math.max(a.y + a.height, c.y + c.height) - y };
};
function focusOf(b, displayId) {
  let f = b.mode === "point" && b.displayId === displayId ? around(b.gx, b.gy, TARGET_RADIUS) : void 0;
  for (const h of b.highlights) {
    if (displayAt(h.gx + h.gw / 2, h.gy + h.gh / 2).id !== displayId) continue;
    const r = { x: h.gx - 8, y: h.gy - 8, width: h.gw + 16, height: h.gh + 16 };
    f = f ? union(f, r) : r;
  }
  return f;
}
function setAnchor(b, displayId, base) {
  const focus = focusOf(b, displayId);
  b.anchor = focus ? { displayId, frame: base, focus } : void 0;
}
function park(b, why) {
  if (!b.anchor) return;
  b.parked = { mode: b.mode, gx: b.gx, gy: b.gy, label: b.label, highlights: b.highlights, anchor: b.anchor, at: Date.now() };
  Object.assign(b, { mode: "home", label: void 0, highlights: [], anchor: void 0 });
  if (b.state === "pointing") b.state = "idle";
  sendAll("clear-buddy", { id: b.id });
  render();
  log(`buddy ${b.id} parked: ${why}`);
}
function unpark(b) {
  const p = b.parked;
  b.parked = void 0;
  Object.assign(b, { mode: p.mode, gx: p.gx, gy: p.gy, displayId: p.anchor.displayId, label: p.label, highlights: p.highlights, anchor: p.anchor });
  if (p.mode === "point") b.state = "pointing";
  render();
  if (p.label) send(surfaceFor(b), "say", { id: b.id, text: p.label, ms: 0 });
  for (const h of p.highlights) showHighlight(b, h);
  log(`buddy ${b.id} back at its spot`);
}
function checkScene(f) {
  for (const b of buddies.values()) {
    if (b.anchor?.displayId === f.displayId) {
      const local = layoutDiff(b.anchor.frame, f, b.anchor.focus);
      const whole = layoutDiff(b.anchor.frame, f);
      if (local.blockFraction > 0.35 || whole.blockFraction > 0.3) park(b, `layout changed (target ${local.blockFraction.toFixed(2)}, screen ${whole.blockFraction.toFixed(2)})`);
    } else if (b.parked?.anchor.displayId === f.displayId) {
      if (Date.now() - b.parked.at > 10 * 6e4) {
        b.parked = void 0;
        continue;
      }
      const local = layoutDiff(b.parked.anchor.frame, f, b.parked.anchor.focus);
      const whole = layoutDiff(b.parked.anchor.frame, f);
      if (local.blockFraction <= 0.06 && whole.blockFraction <= 0.12) unpark(b);
    }
  }
}
function onSpaceChange() {
  log("space changed");
  for (const b of buddies.values()) if (b.anchor) park(b, "space changed");
}
var watching = false;
async function watchLoop() {
  if (watching) return;
  watching = true;
  const settling = /* @__PURE__ */ new Set();
  let ticks = 0;
  const needed = () => [...buddies.values()].some((b) => b.anchor || b.parked || b.follow);
  while (buddies.size) {
    if (!needed()) {
      if (latest.size) log("watcher idle");
      latest.clear();
      settling.clear();
      await sleep(250);
      continue;
    }
    if (!latest.size) log("watching the screen");
    if (++ticks % 200 === 0) log(`watcher alive (${ticks} samples)`);
    try {
      for (const [id, f] of await sampleFrames()) {
        const prev = latest.get(id);
        latest.set(id, f);
        checkScene(f);
        if (!prev) continue;
        if (pixelDiff(prev, f).blocks > 0) settling.add(id);
        else if (settling.delete(id)) {
          for (const b of buddies.values()) if (b.follow) enqueue(b, { type: "screen_changed", display: displayIndex(id) });
        }
      }
    } catch (e) {
      log("watch error", e);
      await sleep(2e3);
    }
    await sleep(200);
  }
  latest.clear();
  watching = false;
}
function mostRecent() {
  return [...buddies.values()].sort((a, b) => b.lastActive - a.lastActive)[0];
}
function openInput(b) {
  const s = surfaceFor(b);
  if (!s) return;
  s.win.setFocusable(true);
  import_electron3.app.focus({ steal: true });
  s.win.focus();
  send(s, "open-input", { id: b.id });
}
import_electron3.ipcMain.on("send-message", (_e, m) => {
  const b = buddies.get(m.id);
  if (!b || !m.text) return;
  retreat(b);
  b.state = "thinking";
  touch(b);
  render();
  setStatus(b, "Thinking");
  enqueue(b, { type: "message", text: m.text });
});
import_electron3.ipcMain.on("close-input", (e) => {
  const s = surfaceOf(e.sender);
  if (!s) return;
  s.win.setFocusable(false);
  import_electron3.app.hide();
  setTimeout(() => surfaces.forEach((x) => x.win.showInactive()), 80);
});
import_electron3.ipcMain.on("hover", (e, over) => {
  import_electron3.BrowserWindow.fromWebContents(e.sender)?.setIgnoreMouseEvents(!over, { forward: true });
});
import_electron3.ipcMain.on("click-buddy", (_e, id) => {
  const b = buddies.get(id);
  if (b) openInput(b);
});
function pickDisplay(index) {
  if (index !== void 0) {
    const d = orderedDisplays()[index - 1];
    if (!d) throw new Error(`There is no display ${index}; there are ${orderedDisplays().length}.`);
    return d;
  }
  return displayAt(import_electron3.screen.getCursorScreenPoint().x, import_electron3.screen.getCursorScreenPoint().y);
}
function needShot(b) {
  if (!b.shot) throw new Error("Take a screenshot first: coordinates are in the pixel space of your last screenshot or zoom.");
  return b.shot;
}
function settle(b) {
  if (b.state === "thinking") b.state = b.mode === "point" ? "pointing" : "idle";
}
async function captureNow(d) {
  const img = await grab(d);
  const frame = toFrame(img.resize({ width: FRAME_WIDTH, quality: "good" }), d.id, d.bounds);
  lastFull = { displayId: d.id, img, frame, watched: newestFrame(d.id, 1500) };
  return { img, frame };
}
function newestFrame(displayId, maxAgeMs) {
  const f = latest.get(displayId);
  return f && Date.now() - f.at < maxAgeMs ? f : void 0;
}
async function smartCapture(b, d, maxDim, fresh) {
  const { img: full, frame } = await captureNow(d);
  const where = { display: displayIndex(d.id), displays: orderedDisplays().length };
  const candidates = fresh ? [] : b.shots.filter((s) => s.displayId === d.id && s.maxDim === maxDim);
  const same = candidates.find((s) => pixelDiff(s.frame, frame).blocks === 0);
  if (same) {
    b.shot = same;
    same.frame = frame;
    log(`screenshot: same as #${same.n}`);
    return { kind: "same", n: same.n, ageSec: Math.round((Date.now() - same.at) / 1e3), points: same.points, ...where };
  }
  const last = candidates[0];
  const diff = last && pixelDiff(last.frame, frame);
  if (last && diff?.bbox && diff.blockFraction < 0.3) {
    const t = last.transform;
    const p0 = toImage(t, diff.bbox.x, diff.bbox.y);
    const p1 = toImage(t, diff.bbox.x + diff.bbox.width, diff.bbox.y + diff.bbox.height);
    const x0 = Math.max(0, Math.floor(p0.x) - 24), y0 = Math.max(0, Math.floor(p0.y) - 24);
    const x1 = Math.min(last.width, Math.ceil(p1.x) + 24), y1 = Math.min(last.height, Math.ceil(p1.y) + 24);
    if ((x1 - x0) * (y1 - y0) < 0.35 * last.width * last.height) {
      const g0 = toGlobal(t, x0, y0), g1 = toGlobal(t, x1, y1);
      const k = full.getSize().width / d.bounds.width;
      const crop = full.crop({ x: Math.round((g0.x - d.bounds.x) * k), y: Math.round((g0.y - d.bounds.y) * k), width: Math.round((g1.x - g0.x) * k), height: Math.round((g1.y - g0.y) * k) }).resize({ width: x1 - x0, height: y1 - y0, quality: "best" });
      Object.assign(last, { frame, at: Date.now() });
      b.shot = last;
      b.shots = [last, ...b.shots.filter((s) => s !== last)];
      log(`screenshot: region of #${last.n} (${x1 - x0}x${y1 - y0})`);
      return { kind: "region", n: last.n, x: x0, y: y0, ...encode(crop), ...where };
    }
  }
  const img = fitTo(full, maxDim);
  const { width, height } = img.getSize();
  const shot = {
    n: ++b.shotCount,
    displayId: d.id,
    width,
    height,
    maxDim,
    frame,
    at: Date.now(),
    points: [],
    transform: { displayId: d.id, ox: d.bounds.x, oy: d.bounds.y, sx: d.bounds.width / width, sy: d.bounds.height / height }
  };
  b.shots = [shot, ...b.shots].slice(0, MAX_SHOTS);
  b.shot = shot;
  log(`screenshot: new #${shot.n}`);
  return { kind: "full", n: shot.n, ...encode(img), ...where };
}
var LOOK_OPS = /* @__PURE__ */ new Set(["capture", "zoom", "cursor", "calibrate"]);
var lookHandlers = {
  async capture(b, { maxDim = 1280, display, fresh = false }) {
    setStatus(b, "Looking at your screen");
    try {
      return await smartCapture(b, pickDisplay(display), maxDim, fresh);
    } finally {
      setStatus(b, "Thinking");
    }
  },
  async zoom(b, { x, y, width, height, maxDim = 1024 }) {
    const t = needShot(b).transform;
    const d = displayById(t.displayId);
    if (!d) throw new Error("That display is gone; take a new screenshot.");
    setStatus(b, "Looking closer");
    try {
      const now = newestFrame(d.id, 1500);
      const reuse = lastFull?.displayId === d.id && lastFull.watched && now && pixelDiff(lastFull.watched, now).blocks === 0;
      const { img: full, frame } = reuse ? lastFull : await captureNow(d);
      const tl = toGlobal(t, x, y);
      const br = toGlobal(t, x + width, y + height);
      const size = full.getSize();
      const k = size.width / d.bounds.width;
      const rx = Math.max(0, Math.round((tl.x - d.bounds.x) * k));
      const ry = Math.max(0, Math.round((tl.y - d.bounds.y) * k));
      const rw = Math.min(size.width - rx, Math.round((br.x - tl.x) * k));
      const rh = Math.min(size.height - ry, Math.round((br.y - tl.y) * k));
      if (rw < 4 || rh < 4) throw new Error("That region is empty or off the display.");
      const img = fitTo(full.crop({ x: rx, y: ry, width: rw, height: rh }), maxDim, 512);
      const out = img.getSize();
      b.shot = {
        n: ++b.shotCount,
        displayId: d.id,
        width: out.width,
        height: out.height,
        maxDim: 0,
        frame,
        at: Date.now(),
        points: [],
        transform: { displayId: d.id, ox: d.bounds.x + rx / k, oy: d.bounds.y + ry / k, sx: rw / k / out.width, sy: rh / k / out.height }
      };
      return { ...encode(img), n: b.shot.n };
    } finally {
      setStatus(b, "Thinking");
    }
  },
  cursor(b) {
    const p = import_electron3.screen.getCursorScreenPoint();
    if (!b.shot) return { x: p.x, y: p.y, space: "screen" };
    const q = toImage(b.shot.transform, p.x, p.y);
    return { x: Math.round(q.x), y: Math.round(q.y), space: "image" };
  },
  async calibrate(b) {
    const d = b.shot ? displayById(b.shot.transform.displayId) ?? pickDisplay() : pickDisplay();
    setStatus(b, "Calibrating");
    try {
      return await calibrate(d);
    } finally {
      setStatus(b);
    }
  }
};
var handlers = {
  bye(b) {
    removeBuddy(b, "deactivated");
    return {};
  },
  point(b, { x, y, label }) {
    const shot = needShot(b);
    const g = toGlobal(shot.transform, x, y);
    const d = displayAt(g.x, g.y);
    shot.points = [{ label, x: Math.round(x), y: Math.round(y) }, ...shot.points].slice(0, 8);
    const now = newestFrame(d.id, 1500);
    const stale = now && layoutDiff(shot.frame, now, around(g.x, g.y, TARGET_RADIUS)).blockFraction > 0.25;
    Object.assign(b, { mode: "point", gx: g.x, gy: g.y, displayId: d.id, state: "pointing", label, parked: void 0 });
    setAnchor(b, d.id, now ?? shot.frame);
    setStatus(b);
    touch(b);
    render();
    send(surfaceFor(b), "say", { id: b.id, text: label ?? "", ms: 0 });
    return {
      screenX: Math.round(g.x),
      screenY: Math.round(g.y),
      warning: stale ? "The screen around that spot changed since your screenshot; take a new one to check." : void 0
    };
  },
  highlight(b, { x, y, width, height, label }) {
    const shot = needShot(b);
    const a = toGlobal(shot.transform, x, y);
    const c = toGlobal(shot.transform, x + width, y + height);
    const h = { gx: a.x, gy: a.y, gw: c.x - a.x, gh: c.y - a.y, label: label ?? "" };
    const d = displayAt(a.x + h.gw / 2, a.y + h.gh / 2);
    b.highlights.push(h);
    b.parked = void 0;
    setAnchor(b, d.id, newestFrame(d.id, 1500) ?? shot.frame);
    settle(b);
    setStatus(b);
    touch(b);
    showHighlight(b, h);
    return {};
  },
  say(b, { text, ms }) {
    settle(b);
    setStatus(b);
    touch(b);
    render();
    send(surfaceFor(b), "say", { id: b.id, text, ms });
    return {};
  },
  clear(b) {
    b.state = "idle";
    setStatus(b);
    retreat(b);
    return {};
  },
  async next_event(b, { timeoutMs }) {
    settle(b);
    setStatus(b);
    if (b.queue.length) return { event: b.queue.shift() };
    b.listening = true;
    render();
    const event = await new Promise((resolve) => {
      const t = setTimeout(() => {
        b.waiter = void 0;
        resolve(null);
      }, timeoutMs);
      b.waiter = (e) => {
        clearTimeout(t);
        b.waiter = void 0;
        resolve(e);
      };
    });
    setTimeout(() => {
      if (!b.waiter && buddies.has(b.id)) {
        b.listening = false;
        render();
      }
    }, 2e3);
    return { event };
  },
  follow(b, { on }) {
    b.follow = on;
    return {};
  }
};
async function calibrate(d) {
  const win = new import_electron3.BrowserWindow({
    ...d.bounds,
    transparent: true,
    frame: false,
    hasShadow: false,
    focusable: false,
    show: false,
    enableLargerThanScreen: true,
    skipTaskbar: true,
    alwaysOnTop: true
  });
  try {
    win.setBounds(d.bounds);
    win.setAlwaysOnTop(true, "screen-saver");
    win.setIgnoreMouseEvents(true);
    const wb = win.getBounds();
    const inset = 90;
    const spots = [
      ["top left", inset, inset],
      ["top right", wb.width - inset, inset],
      ["centre", wb.width / 2, wb.height / 2],
      ["bottom left", inset, wb.height - inset],
      ["bottom right", wb.width - inset, wb.height - inset]
    ];
    const marks = spots.map(([, x, y]) => `<div style="position:fixed;left:${x - 9}px;top:${y - 9}px;width:18px;height:18px;background:#ff00ff"></div>`);
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<body style="margin:0;background:transparent">${marks.join("")}</body>`));
    win.showInactive();
    await sleep(400);
    const full = await grab(d);
    const k = full.getSize().width / d.bounds.width;
    const lines = [];
    let maxError = 0;
    for (const [name, x, y] of spots) {
      const ex = wb.x + x, ey = wb.y + y;
      const m = findMarker(full, (ex - d.bounds.x) * k, (ey - d.bounds.y) * k, 140 * k);
      if (!m) {
        lines.push(`${name}: marker not found`);
        maxError = Infinity;
        continue;
      }
      const dx = d.bounds.x + m.x / k - ex, dy = d.bounds.y + m.y / k - ey;
      maxError = Math.max(maxError, Math.hypot(dx, dy));
      lines.push(`${name}: off by (${dx.toFixed(1)}, ${dy.toFixed(1)}) pt`);
    }
    const offset = wb.y - d.bounds.y;
    const verdict = maxError === Infinity ? "Some markers were not found (another window may cover them, or Screen Recording is off)." : maxError <= 2 ? "Calibrated: screenshot pixels map to the screen within 2 pt." : "Mapping is off by more than 2 pt; pointing will miss small targets.";
    const report = [
      `Display ${displayIndex(d.id)} of ${orderedDisplays().length}: ${d.bounds.width}x${d.bounds.height} pt at (${d.bounds.x}, ${d.bounds.y}), scale ${d.scaleFactor}x.`,
      offset ? `Note: macOS placed overlay windows ${offset} pt below the display top; the hub compensates.` : "",
      ...lines,
      verdict
    ].filter(Boolean).join("\n");
    log("calibration", report);
    return { report, maxError };
  } finally {
    win.destroy();
  }
}
async function handle(conn, line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const reply = (r) => {
    if (!conn.sock.destroyed) conn.sock.write(JSON.stringify(r) + "\n");
  };
  const started = Date.now();
  try {
    let result;
    if (req.op === "hello") {
      result = hello(conn, req);
    } else if (LOOK_OPS.has(req.op)) {
      lastLook = Date.now();
      scheduleIdleQuit();
      result = await lookHandlers[req.op](conn.seer, req);
    } else {
      const b = conn.buddy;
      if (!b || !buddies.has(b.id)) throw new Error("This session has no buddy; call activate.");
      const fn = handlers[req.op];
      if (!fn) throw new Error(`Unknown op ${req.op}`);
      result = await fn(b, req);
    }
    if (req.op !== "next_event") log(`op ${req.op} ${Date.now() - started}ms`);
    reply({ id: req.id, ok: true, result });
  } catch (e) {
    log(`op ${req.op} failed`, e);
    reply({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
function hello(conn, { name }) {
  if (conn.buddy && buddies.has(conn.buddy.id)) return { id: conn.buddy.id, name: conn.buddy.name };
  const used = new Set([...buddies.values()].map((b2) => b2.slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  const b = Object.assign(conn.seer, {
    id: nextBuddyId++,
    name: (name || "agent").slice(0, 32),
    slot,
    conn,
    mode: "home",
    gx: 0,
    gy: 0,
    displayId: import_electron3.screen.getPrimaryDisplay().id,
    state: "idle",
    listening: false,
    status: void 0,
    highlights: [],
    anchor: void 0,
    parked: void 0,
    follow: false,
    queue: [],
    waiter: void 0,
    lastActive: Date.now()
  });
  buddies.set(b.id, b);
  conn.buddy = b;
  clearTimeout(idleTimer);
  log(`buddy ${b.id} (${b.name}) joined`);
  render();
  void watchLoop();
  return { id: b.id, name: b.name };
}
function startServer() {
  try {
    import_node_fs.default.unlinkSync(SOCKET_PATH);
  } catch {
  }
  const server = import_node_net.default.createServer((sock) => {
    const conn = { sock, seer: { shots: [], shotCount: 0 } };
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) void handle(conn, line);
      }
    });
    sock.on("close", () => conn.buddy && removeBuddy(conn.buddy, "session ended"));
    sock.on("error", () => {
    });
  });
  server.on("error", (e) => {
    log("socket server error", e);
    import_electron3.app.exit(1);
  });
  server.listen(SOCKET_PATH, () => {
    import_node_fs.default.chmodSync(SOCKET_PATH, 384);
    log(`hub ${process.pid} listening on ${SOCKET_PATH}`);
  });
}
var LOOK_KEEPALIVE_MS = 2 * 6e4;
var lastLook = 0;
var idleTimer;
function scheduleIdleQuit() {
  clearTimeout(idleTimer);
  if (buddies.size) return;
  const wait = Math.max(IDLE_QUIT_MS, lastLook + LOOK_KEEPALIVE_MS - Date.now());
  idleTimer = setTimeout(() => {
    if (buddies.size) return;
    if (Date.now() - lastLook < LOOK_KEEPALIVE_MS) return scheduleIdleQuit();
    log("no buddies and no recent looks; quitting");
    import_electron3.app.quit();
  }, wait);
}
if (isHub) {
  import_electron3.app.whenReady().then(() => {
    for (const d of orderedDisplays()) createSurface(d);
    import_electron3.screen.on("display-added", rebuildSurfaces);
    import_electron3.screen.on("display-removed", rebuildSurfaces);
    import_electron3.screen.on("display-metrics-changed", rebuildSurfaces);
    import_electron3.systemPreferences.subscribeWorkspaceNotification("NSWorkspaceActiveSpaceDidChangeNotification", onSpaceChange);
    if (!import_electron3.globalShortcut.register(SHORTCUT, () => {
      const b = mostRecent();
      if (b) openInput(b);
    })) log(`could not register shortcut ${SHORTCUT}`);
    startServer();
    scheduleIdleQuit();
  });
  import_electron3.app.on("window-all-closed", () => {
  });
  import_electron3.app.on("will-quit", () => {
    import_electron3.globalShortcut.unregisterAll();
    try {
      import_node_fs.default.unlinkSync(SOCKET_PATH);
    } catch {
    }
    log("hub stopped");
  });
}
process.on("uncaughtException", (e) => log("uncaught", e));
