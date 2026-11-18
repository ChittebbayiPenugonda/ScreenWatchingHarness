// The Screen Buddy hub: one per machine. Owns the overlay windows (one per display), every session's buddy,
// the hotkey, screen capture, calibration, and scene tracking. Adapters talk to it over a Unix socket.
// It is started by the first adapter that needs it and quits when no buddies are left.
//
// Scene tracking, in short:
//  - While any buddy is on screen, small frames of every display are sampled continuously (~3 per second).
//  - A buddy that is pointing or highlighting remembers what the screen looked like there (its anchor).
//    If the layout around its target changes (scroll, navigation, app or Space switch), it parks in its dock;
//    if that scene comes back (e.g. you swipe back), it returns to the spot. Space switches are caught instantly.
//  - Any session can look (screenshot, zoom) without a buddy on screen.
//  - Screenshots go through a per-session scene cache: unchanged screens cost no image, partly changed ones send
//    only the changed region, and returning to a screen the agent already saw reuses that screenshot.
import { app, BrowserWindow, screen, ipcMain, globalShortcut, systemPreferences, type Display, type WebContents, type NativeImage } from "electron";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { HUB_DIR, SOCKET_PATH, LOG_PATH, type BuddyEvent, type Capture, type Op, type Ops, type Request, type Response } from "../shared/protocol.js";
import { grab, fitTo, encode, findMarker, toGlobal, toImage, type Transform } from "./capture.js";
import { sampleFrames, toFrame, pixelDiff, layoutDiff, around, FRAME_WIDTH, type Frame, type Rect } from "./frames.js";

const SHOW_IN_CAPTURE = process.argv.includes("--show-in-capture"); // debug: let screenshots see the buddies
const SHORTCUT = process.env.SWH_SHORTCUT || "Alt+Shift+Space";
const IDLE_QUIT_MS = Number(process.env.SCREEN_BUDDY_IDLE_MS || 30_000);
const RENDERER_DIR = path.join(__dirname, "..", "..", "overlay");
const TARGET_RADIUS = 40; // pt around a pointed spot that must stay put for the buddy to stay
const MAX_SHOTS = 6;

fs.mkdirSync(HUB_DIR, { recursive: true });
function log(...parts: unknown[]) {
  const line = parts.map((p) => (p instanceof Error ? p.stack : typeof p === "string" ? p : JSON.stringify(p))).join(" ");
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

app.setName("screen-buddy");
app.setPath("userData", path.join(HUB_DIR, "electron"));
// Two adapters can race to start a hub; the single-instance lock decides the winner.
const isHub = app.requestSingleInstanceLock();
if (!isHub) {
  log("another hub is running; exiting");
  app.exit(0);
}
app.dock?.hide();

// ---------- buddies ----------

type Shot = {
  n: number;
  displayId: number;
  transform: Transform;
  width: number;
  height: number;
  maxDim: number; // 0 for zooms, which never satisfy a screenshot request
  frame: Frame; // the screen when the agent last saw it through this shot
  at: number;
  points: { label?: string; x: number; y: number }[];
};
type Highlight = { gx: number; gy: number; gw: number; gh: number; label: string };
type Anchor = { displayId: number; frame: Frame; focus: Rect };
type Parked = { mode: "home" | "point"; gx: number; gy: number; label?: string; highlights: Highlight[]; anchor: Anchor; at: number };

// Every connection can look at the screen; the scene cache lives here. When the session activates,
// this same object becomes its buddy, so the cache carries over.
type Seer = {
  shots: Shot[]; // newest first
  shot?: Shot; // the image the agent's coordinates currently refer to
  shotCount: number;
};
type Conn = { sock: net.Socket; seer: Seer; buddy?: Buddy };
type Buddy = Seer & {
  id: number;
  name: string;
  slot: number; // picks colour and shape
  conn: Conn;
  mode: "home" | "point";
  gx: number;
  gy: number;
  displayId: number;
  label?: string;
  state: "idle" | "thinking" | "pointing";
  listening: boolean;
  status?: string;
  highlights: Highlight[];
  anchor?: Anchor; // what the screen looked like where the buddy is showing something
  parked?: Parked; // what it was showing before the scene changed away
  follow: boolean;
  queue: BuddyEvent[];
  waiter?: (e: BuddyEvent | null) => void;
  lastActive: number;
};
const buddies = new Map<number, Buddy>();
let nextBuddyId = 1;

function touch(b: Buddy) {
  b.lastActive = Date.now();
}

function enqueue(b: Buddy, e: BuddyEvent) {
  if (b.waiter) return b.waiter(e);
  if (e.type === "screen_changed" && b.queue.some((q) => q.type === "screen_changed")) return;
  b.queue.push(e);
}

function removeBuddy(b: Buddy, why: string) {
  if (!buddies.delete(b.id)) return;
  log(`buddy ${b.id} (${b.name}) left: ${why}`);
  b.waiter?.(null);
  for (const s of surfaces.values()) send(s, "clear-buddy", { id: b.id });
  render();
  scheduleIdleQuit();
}

// ---------- displays and overlay windows ----------

type Surface = { win: BrowserWindow; display: Display; ready: boolean };
const surfaces = new Map<number, Surface>();

function orderedDisplays(): Display[] {
  const primary = screen.getPrimaryDisplay();
  const rest = screen.getAllDisplays().filter((d) => d.id !== primary.id);
  return [primary, ...rest.sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)];
}
const displayIndex = (id: number) => orderedDisplays().findIndex((d) => d.id === id) + 1;
const displayById = (id: number) => screen.getAllDisplays().find((d) => d.id === id);
const displayAt = (x: number, y: number) => screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });

function createSurface(display: Display) {
  const { x, y, width, height } = display.bounds;
  const win = new BrowserWindow({
    x, y, width, height,
    transparent: true, frame: false, hasShadow: false, resizable: false, movable: false,
    focusable: false, enableLargerThanScreen: true, skipTaskbar: true, alwaysOnTop: true, show: false,
    webPreferences: { preload: path.join(RENDERER_DIR, "preload.cjs") },
  });
  win.setBounds({ x, y, width, height }); // ask again: macOS may push it below the menu bar
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true }); // click-through, but still report hovering
  win.setContentProtection(!SHOW_IN_CAPTURE); // keep buddies out of the agent's own screenshots
  const s: Surface = { win, display, ready: false };
  win.webContents.on("did-finish-load", () => {
    s.ready = true;
    win.showInactive();
    send(s, "init", { shortcut: SHORTCUT });
    render();
  });
  win.loadFile(path.join(RENDERER_DIR, "overlay.html"));
  surfaces.set(display.id, s);
}

let rebuildTimer: NodeJS.Timeout | undefined;
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

function send(s: Surface | undefined, channel: string, data: unknown) {
  if (s?.ready && !s.win.isDestroyed()) s.win.webContents.send(channel, data);
}
const sendAll = (channel: string, data: unknown) => surfaces.forEach((s) => send(s, channel, data));

const displayOf = (b: Buddy) => (b.mode === "home" ? screen.getPrimaryDisplay().id : b.displayId);
const surfaceFor = (b: Buddy) => surfaces.get(displayOf(b)) ?? surfaces.get(screen.getPrimaryDisplay().id);
const surfaceOf = (wc: WebContents) => [...surfaces.values()].find((s) => s.win.webContents === wc);

// Where a buddy should be, in global screen points.
function target(b: Buddy) {
  if (b.mode === "point") return { x: b.gx, y: b.gy };
  const s = surfaces.get(screen.getPrimaryDisplay().id);
  const bounds = s?.win.getBounds() ?? screen.getPrimaryDisplay().bounds;
  const docked = [...buddies.values()].sort((a, c) => a.id - c.id);
  const i = docked.indexOf(b);
  return { x: bounds.x + bounds.width - 46 - i * 58, y: bounds.y + bounds.height - 50 };
}

// Push every buddy's state to the window of the display it is on (coordinates local to that window).
function render() {
  for (const s of surfaces.values()) {
    const wb = s.win.getBounds();
    const list = [...buddies.values()]
      .filter((b) => surfaceFor(b) === s)
      .map((b) => {
        const t = target(b);
        return { id: b.id, name: b.name, slot: b.slot, state: b.state, listening: b.listening, mode: b.mode, x: t.x - wb.x, y: t.y - wb.y };
      });
    send(s, "buddies", list);
  }
}

// A short "what I'm doing" line in the buddy's bubble while the agent works (speech always wins over it).
function setStatus(s: Seer, text?: string) {
  const b = s as Buddy;
  if (!buddies.has(b.id) || buddies.get(b.id) !== b || b.status === text) return; // no buddy on screen: nothing to show
  b.status = text;
  sendAll("status", { id: b.id, text: text ?? "" });
}

function showHighlight(b: Buddy, h: Highlight) {
  const s = surfaces.get(displayAt(h.gx + h.gw / 2, h.gy + h.gh / 2).id);
  if (!s) return;
  const wb = s.win.getBounds();
  send(s, "highlight", { id: b.id, slot: b.slot, x: h.gx - wb.x, y: h.gy - wb.y, w: h.gw, h: h.gh, label: h.label });
}

// Go home and drop whatever the buddy was showing.
function retreat(b: Buddy) {
  Object.assign(b, { mode: "home", label: undefined, highlights: [], anchor: undefined, parked: undefined });
  if (b.state === "pointing") b.state = "idle";
  sendAll("clear-buddy", { id: b.id });
  render();
}

// ---------- scene tracking ----------

const latest = new Map<number, Frame>(); // newest watcher frame of each display (anchors compare against these)
// newest full-res capture, with the watcher's frame from that moment (to tell later whether the screen changed since)
let lastFull: { displayId: number; img: NativeImage; frame: Frame; watched?: Frame } | undefined;

const union = (a: Rect, c: Rect): Rect => {
  const x = Math.min(a.x, c.x), y = Math.min(a.y, c.y);
  return { x, y, width: Math.max(a.x + a.width, c.x + c.width) - x, height: Math.max(a.y + a.height, c.y + c.height) - y };
};

// The area that has to stay put for what the buddy shows to still make sense.
function focusOf(b: Buddy, displayId: number): Rect | undefined {
  let f: Rect | undefined = b.mode === "point" && b.displayId === displayId ? around(b.gx, b.gy, TARGET_RADIUS) : undefined;
  for (const h of b.highlights) {
    if (displayAt(h.gx + h.gw / 2, h.gy + h.gh / 2).id !== displayId) continue;
    const r = { x: h.gx - 8, y: h.gy - 8, width: h.gw + 16, height: h.gh + 16 };
    f = f ? union(f, r) : r;
  }
  return f;
}

function setAnchor(b: Buddy, displayId: number, base: Frame) {
  const focus = focusOf(b, displayId);
  b.anchor = focus ? { displayId, frame: base, focus } : undefined;
}

// The scene moved away from what the buddy was showing: tuck it into the dock but remember the spot.
function park(b: Buddy, why: string) {
  if (!b.anchor) return;
  b.parked = { mode: b.mode, gx: b.gx, gy: b.gy, label: b.label, highlights: b.highlights, anchor: b.anchor, at: Date.now() };
  Object.assign(b, { mode: "home", label: undefined, highlights: [], anchor: undefined });
  if (b.state === "pointing") b.state = "idle";
  sendAll("clear-buddy", { id: b.id });
  render();
  log(`buddy ${b.id} parked: ${why}`);
}

// The scene it was showing is back (e.g. the user swiped back): return to the spot.
function unpark(b: Buddy) {
  const p = b.parked!;
  b.parked = undefined;
  Object.assign(b, { mode: p.mode, gx: p.gx, gy: p.gy, displayId: p.anchor.displayId, label: p.label, highlights: p.highlights, anchor: p.anchor });
  if (p.mode === "point") b.state = "pointing";
  render();
  if (p.label) send(surfaceFor(b), "say", { id: b.id, text: p.label, ms: 0 });
  for (const h of p.highlights) showHighlight(b, h);
  log(`buddy ${b.id} back at its spot`);
}

// Compare each buddy's anchor (or parked anchor) with the newest frame of a display.
function checkScene(f: Frame) {
  for (const b of buddies.values()) {
    if (b.anchor?.displayId === f.displayId) {
      const local = layoutDiff(b.anchor.frame, f, b.anchor.focus);
      const whole = layoutDiff(b.anchor.frame, f);
      if (local.blockFraction > 0.35 || whole.blockFraction > 0.3) park(b, `layout changed (target ${local.blockFraction.toFixed(2)}, screen ${whole.blockFraction.toFixed(2)})`);
    } else if (b.parked?.anchor.displayId === f.displayId) {
      if (Date.now() - b.parked.at > 10 * 60_000) {
        b.parked = undefined;
        continue;
      }
      const local = layoutDiff(b.parked.anchor.frame, f, b.parked.anchor.focus);
      const whole = layoutDiff(b.parked.anchor.frame, f);
      // The target area must look the same; elsewhere small differences (a new tab, the clock) are fine.
      if (local.blockFraction <= 0.06 && whole.blockFraction <= 0.12) unpark(b);
    }
  }
}

// Instant: a Space switch (three-finger swipe, Mission Control) changes everything at once.
function onSpaceChange() {
  log("space changed");
  for (const b of buddies.values()) if (b.anchor) park(b, "space changed");
}

let watching = false;
async function watchLoop() {
  if (watching) return;
  watching = true;
  const settling = new Set<number>();
  let ticks = 0;
  // Only sample while some buddy is showing something, waiting to return to a spot, or following along.
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
          // changed, then held still for one sample: tell buddies that follow along, once
          for (const b of buddies.values()) if (b.follow) enqueue(b, { type: "screen_changed", display: displayIndex(id) });
        }
      }
    } catch (e) {
      log("watch error", e);
      await sleep(2000);
    }
    await sleep(200);
  }
  latest.clear();
  watching = false;
}

// ---------- talking to the user ----------

function mostRecent() {
  return [...buddies.values()].sort((a, b) => b.lastActive - a.lastActive)[0];
}

function openInput(b: Buddy) {
  const s = surfaceFor(b);
  if (!s) return;
  s.win.setFocusable(true);
  app.focus({ steal: true });
  s.win.focus();
  send(s, "open-input", { id: b.id });
}

ipcMain.on("send-message", (_e, m: { id: number; text: string }) => {
  const b = buddies.get(m.id);
  if (!b || !m.text) return;
  retreat(b); // a new question: come back to the corner and work on it there
  b.state = "thinking";
  touch(b);
  render();
  setStatus(b, "Thinking");
  enqueue(b, { type: "message", text: m.text });
});

ipcMain.on("close-input", (e) => {
  const s = surfaceOf(e.sender);
  if (!s) return;
  s.win.setFocusable(false);
  app.hide(); // hand keyboard focus back to whatever app was in front
  setTimeout(() => surfaces.forEach((x) => x.win.showInactive()), 80);
});

// Buddies are clickable even though the rest of the overlay is click-through.
ipcMain.on("hover", (e, over: boolean) => {
  BrowserWindow.fromWebContents(e.sender)?.setIgnoreMouseEvents(!over, { forward: true });
});
ipcMain.on("click-buddy", (_e, id: number) => {
  const b = buddies.get(id);
  if (b) openInput(b);
});

// ---------- requests from adapters ----------

function pickDisplay(index?: number) {
  if (index !== undefined) {
    const d = orderedDisplays()[index - 1];
    if (!d) throw new Error(`There is no display ${index}; there are ${orderedDisplays().length}.`);
    return d;
  }
  return displayAt(screen.getCursorScreenPoint().x, screen.getCursorScreenPoint().y);
}

function needShot(b: Seer) {
  if (!b.shot) throw new Error("Take a screenshot first: coordinates are in the pixel space of your last screenshot or zoom.");
  return b.shot;
}

function settle(b: Buddy) {
  if (b.state === "thinking") b.state = b.mode === "point" ? "pointing" : "idle";
}

// A full-resolution image plus a small frame made from it (for the scene cache, which compares these
// frames only with each other). One capture, not two.
async function captureNow(d: Display) {
  const img = await grab(d);
  const frame = toFrame(img.resize({ width: FRAME_WIDTH, quality: "good" }), d.id, d.bounds);
  lastFull = { displayId: d.id, img, frame, watched: newestFrame(d.id, 1500) };
  return { img, frame };
}

function newestFrame(displayId: number, maxAgeMs: number) {
  const f = latest.get(displayId);
  return f && Date.now() - f.at < maxAgeMs ? f : undefined;
}

// Screenshot with the scene cache in front of it.
async function smartCapture(b: Seer, d: Display, maxDim: number, fresh: boolean): Promise<Capture> {
  const { img: full, frame } = await captureNow(d);
  const where = { display: displayIndex(d.id), displays: orderedDisplays().length };
  const candidates = fresh ? [] : b.shots.filter((s) => s.displayId === d.id && s.maxDim === maxDim);

  // 1. Nothing changed since a screenshot the agent already has (the latest, or an earlier one it can return to).
  const same = candidates.find((s) => pixelDiff(s.frame, frame).blocks === 0);
  if (same) {
    b.shot = same;
    same.frame = frame;
    log(`screenshot: same as #${same.n}`);
    return { kind: "same", n: same.n, ageSec: Math.round((Date.now() - same.at) / 1000), points: same.points, ...where };
  }

  // 2. Only part of the latest screenshot changed: send just that part, at the same scale.
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
      const crop = full
        .crop({ x: Math.round((g0.x - d.bounds.x) * k), y: Math.round((g0.y - d.bounds.y) * k), width: Math.round((g1.x - g0.x) * k), height: Math.round((g1.y - g0.y) * k) })
        .resize({ width: x1 - x0, height: y1 - y0, quality: "best" });
      Object.assign(last, { frame, at: Date.now() });
      b.shot = last;
      b.shots = [last, ...b.shots.filter((s) => s !== last)];
      log(`screenshot: region of #${last.n} (${x1 - x0}x${y1 - y0})`);
      return { kind: "region", n: last.n, x: x0, y: y0, ...encode(crop), ...where };
    }
  }

  // 3. A new screenshot.
  const img = fitTo(full, maxDim);
  const { width, height } = img.getSize();
  const shot: Shot = {
    n: ++b.shotCount, displayId: d.id, width, height, maxDim, frame, at: Date.now(), points: [],
    transform: { displayId: d.id, ox: d.bounds.x, oy: d.bounds.y, sx: d.bounds.width / width, sy: d.bounds.height / height },
  };
  b.shots = [shot, ...b.shots].slice(0, MAX_SHOTS);
  b.shot = shot;
  log(`screenshot: new #${shot.n}`);
  return { kind: "full", n: shot.n, ...encode(img), ...where };
}

type Handler<K extends Op, T = Buddy> = (b: T, args: Ops[K]["args"]) => Promise<Ops[K]["result"]> | Ops[K]["result"];

// Looking needs no buddy on screen: any session can ask for these.
type LookOp = "capture" | "zoom" | "cursor" | "calibrate";
const LOOK_OPS = new Set<Op>(["capture", "zoom", "cursor", "calibrate"]);
const lookHandlers: { [K in LookOp]: Handler<K, Seer> } = {

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
      // Reuse the last full-resolution capture if the screen has not changed since.
      const now = newestFrame(d.id, 1500);
      const reuse = lastFull?.displayId === d.id && lastFull.watched && now && pixelDiff(lastFull.watched, now).blocks === 0;
      const { img: full, frame } = reuse ? lastFull! : await captureNow(d);
      const tl = toGlobal(t, x, y);
      const br = toGlobal(t, x + width, y + height);
      const size = full.getSize();
      const k = size.width / d.bounds.width; // physical pixels per point
      const rx = Math.max(0, Math.round((tl.x - d.bounds.x) * k));
      const ry = Math.max(0, Math.round((tl.y - d.bounds.y) * k));
      const rw = Math.min(size.width - rx, Math.round((br.x - tl.x) * k));
      const rh = Math.min(size.height - ry, Math.round((br.y - tl.y) * k));
      if (rw < 4 || rh < 4) throw new Error("That region is empty or off the display.");
      const img = fitTo(full.crop({ x: rx, y: ry, width: rw, height: rh }), maxDim, 512);
      const out = img.getSize();
      b.shot = {
        n: ++b.shotCount, displayId: d.id, width: out.width, height: out.height, maxDim: 0, frame, at: Date.now(), points: [],
        transform: { displayId: d.id, ox: d.bounds.x + rx / k, oy: d.bounds.y + ry / k, sx: rw / k / out.width, sy: rh / k / out.height },
      };
      return { ...encode(img), n: b.shot.n };
    } finally {
      setStatus(b, "Thinking");
    }
  },

  cursor(b) {
    const p = screen.getCursorScreenPoint();
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
  },
};

const handlers: { [K in Exclude<Op, "hello" | LookOp>]: Handler<K> } = {
  bye(b) {
    removeBuddy(b, "deactivated");
    return {};
  },

  point(b, { x, y, label }) {
    const shot = needShot(b);
    const g = toGlobal(shot.transform, x, y);
    const d = displayAt(g.x, g.y);
    shot.points = [{ label, x: Math.round(x), y: Math.round(y) }, ...shot.points].slice(0, 8);
    // Has the spot changed since the agent looked? (The agent may have spent a few seconds thinking.)
    const now = newestFrame(d.id, 1500);
    const stale = now && layoutDiff(shot.frame, now, around(g.x, g.y, TARGET_RADIUS)).blockFraction > 0.25;
    Object.assign(b, { mode: "point", gx: g.x, gy: g.y, displayId: d.id, state: "pointing", label, parked: undefined });
    setAnchor(b, d.id, now ?? shot.frame);
    setStatus(b);
    touch(b);
    render();
    send(surfaceFor(b), "say", { id: b.id, text: label ?? "", ms: 0 });
    return {
      screenX: Math.round(g.x),
      screenY: Math.round(g.y),
      warning: stale ? "The screen around that spot changed since your screenshot; take a new one to check." : undefined,
    };
  },

  highlight(b, { x, y, width, height, label }) {
    const shot = needShot(b);
    const a = toGlobal(shot.transform, x, y);
    const c = toGlobal(shot.transform, x + width, y + height);
    const h: Highlight = { gx: a.x, gy: a.y, gw: c.x - a.x, gh: c.y - a.y, label: label ?? "" };
    const d = displayAt(a.x + h.gw / 2, a.y + h.gh / 2);
    b.highlights.push(h);
    b.parked = undefined;
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
    if (b.queue.length) return { event: b.queue.shift()! };
    b.listening = true;
    render();
    const event = await new Promise<BuddyEvent | null>((resolve) => {
      const t = setTimeout(() => {
        b.waiter = undefined;
        resolve(null);
      }, timeoutMs);
      b.waiter = (e) => {
        clearTimeout(t);
        b.waiter = undefined;
        resolve(e);
      };
    });
    // Stay "listening" through the short gap before the agent calls again.
    setTimeout(() => {
      if (!b.waiter && buddies.has(b.id)) {
        b.listening = false;
        render();
      }
    }, 2000);
    return { event };
  },

  follow(b, { on }) {
    b.follow = on;
    return {};
  },

};

// Flash magenta markers at known points, capture, find them, and report how far off the mapping is.
async function calibrate(d: Display) {
  const win = new BrowserWindow({
    ...d.bounds, transparent: true, frame: false, hasShadow: false, focusable: false, show: false,
    enableLargerThanScreen: true, skipTaskbar: true, alwaysOnTop: true,
  });
  try {
    win.setBounds(d.bounds);
    win.setAlwaysOnTop(true, "screen-saver");
    win.setIgnoreMouseEvents(true);
    const wb = win.getBounds();
    const inset = 90;
    const spots: [string, number, number][] = [
      ["top left", inset, inset], ["top right", wb.width - inset, inset], ["centre", wb.width / 2, wb.height / 2],
      ["bottom left", inset, wb.height - inset], ["bottom right", wb.width - inset, wb.height - inset],
    ];
    const marks = spots.map(([, x, y]) => `<div style="position:fixed;left:${x - 9}px;top:${y - 9}px;width:18px;height:18px;background:#ff00ff"></div>`);
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<body style="margin:0;background:transparent">${marks.join("")}</body>`));
    win.showInactive();
    await sleep(400);
    const full = await grab(d);
    const k = full.getSize().width / d.bounds.width;
    const lines: string[] = [];
    let maxError = 0;
    for (const [name, x, y] of spots) {
      const ex = wb.x + x, ey = wb.y + y; // where the marker centre is, in global points
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
    const verdict =
      maxError === Infinity ? "Some markers were not found (another window may cover them, or Screen Recording is off)."
      : maxError <= 2 ? "Calibrated: screenshot pixels map to the screen within 2 pt."
      : "Mapping is off by more than 2 pt; pointing will miss small targets.";
    const report = [
      `Display ${displayIndex(d.id)} of ${orderedDisplays().length}: ${d.bounds.width}x${d.bounds.height} pt at (${d.bounds.x}, ${d.bounds.y}), scale ${d.scaleFactor}x.`,
      offset ? `Note: macOS placed overlay windows ${offset} pt below the display top; the hub compensates.` : "",
      ...lines,
      verdict,
    ].filter(Boolean).join("\n");
    log("calibration", report);
    return { report, maxError };
  } finally {
    win.destroy();
  }
}

async function handle(conn: Conn, line: string) {
  let req: Request;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const reply = (r: Response) => {
    if (!conn.sock.destroyed) conn.sock.write(JSON.stringify(r) + "\n");
  };
  const started = Date.now();
  try {
    let result: unknown;
    if (req.op === "hello") {
      result = hello(conn, req as unknown as Ops["hello"]["args"]);
    } else if (LOOK_OPS.has(req.op)) {
      lastLook = Date.now();
      scheduleIdleQuit();
      result = await (lookHandlers[req.op as LookOp] as Handler<Op, Seer>)(conn.seer, req as never);
    } else {
      const b = conn.buddy;
      if (!b || !buddies.has(b.id)) throw new Error("This session has no buddy; call activate.");
      const fn = (handlers as Record<string, Handler<Op> | undefined>)[req.op];
      if (!fn) throw new Error(`Unknown op ${req.op}`);
      result = await fn(b, req as never);
    }
    if (req.op !== "next_event") log(`op ${req.op} ${Date.now() - started}ms`);
    reply({ id: req.id, ok: true, result });
  } catch (e) {
    log(`op ${req.op} failed`, e);
    reply({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

function hello(conn: Conn, { name }: Ops["hello"]["args"]): Ops["hello"]["result"] {
  if (conn.buddy && buddies.has(conn.buddy.id)) return { id: conn.buddy.id, name: conn.buddy.name };
  const used = new Set([...buddies.values()].map((b) => b.slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  // The connection's seer becomes the buddy, keeping the screenshots it already took.
  const b: Buddy = Object.assign(conn.seer, {
    id: nextBuddyId++, name: (name || "agent").slice(0, 32), slot, conn, mode: "home" as const, gx: 0, gy: 0,
    displayId: screen.getPrimaryDisplay().id, state: "idle" as const, listening: false, status: undefined,
    highlights: [], anchor: undefined, parked: undefined, follow: false, queue: [], waiter: undefined, lastActive: Date.now(),
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
  // We hold the single-instance lock, so any socket file left here belongs to a dead hub.
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {}
  const server = net.createServer((sock) => {
    const conn: Conn = { sock, seer: { shots: [], shotCount: 0 } };
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) void handle(conn, line);
      }
    });
    sock.on("close", () => conn.buddy && removeBuddy(conn.buddy, "session ended"));
    sock.on("error", () => {});
  });
  server.on("error", (e) => {
    log("socket server error", e);
    app.exit(1);
  });
  server.listen(SOCKET_PATH, () => {
    fs.chmodSync(SOCKET_PATH, 0o600);
    log(`hub ${process.pid} listening on ${SOCKET_PATH}`);
  });
}

// Quit once no buddy is on screen and nobody has looked for a while. A session that only looks will
// start the hub again next time (a second or so), so this just avoids keeping it around for nothing.
const LOOK_KEEPALIVE_MS = 2 * 60_000;
let lastLook = 0;
let idleTimer: NodeJS.Timeout | undefined;
function scheduleIdleQuit() {
  clearTimeout(idleTimer);
  if (buddies.size) return;
  const wait = Math.max(IDLE_QUIT_MS, lastLook + LOOK_KEEPALIVE_MS - Date.now());
  idleTimer = setTimeout(() => {
    if (buddies.size) return;
    if (Date.now() - lastLook < LOOK_KEEPALIVE_MS) return scheduleIdleQuit();
    log("no buddies and no recent looks; quitting");
    app.quit();
  }, wait);
}

if (isHub) {
  app.whenReady().then(() => {
    for (const d of orderedDisplays()) createSurface(d);
    screen.on("display-added", rebuildSurfaces);
    screen.on("display-removed", rebuildSurfaces);
    screen.on("display-metrics-changed", rebuildSurfaces);
    systemPreferences.subscribeWorkspaceNotification("NSWorkspaceActiveSpaceDidChangeNotification", onSpaceChange);
    if (!globalShortcut.register(SHORTCUT, () => {
      const b = mostRecent();
      if (b) openInput(b);
    })) log(`could not register shortcut ${SHORTCUT}`);
    startServer();
    scheduleIdleQuit();
  });

  app.on("window-all-closed", () => {}); // the hub decides when to quit, not the windows
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {}
    log("hub stopped");
  });
}
process.on("uncaughtException", (e) => log("uncaught", e));
