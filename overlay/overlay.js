// Draws the buddies on one display. The hub sends where each buddy should be; this page animates it there.
"use strict";

// Each buddy's slot picks a colour and a shape, so buddies on screen at the same time look different.
const SLOTS = [
  { hue: 330, shape: "orb" }, { hue: 172, shape: "square" }, { hue: 262, shape: "pill" },
  { hue: 36, shape: "orb" }, { hue: 205, shape: "square" }, { hue: 128, shape: "pill" },
];
const slotStyle = (slot) => SLOTS[slot % SLOTS.length];

const layer = document.getElementById("layer");
const views = new Map(); // buddy id -> view
const highlights = new Map(); // buddy id -> [elements]
let inputFor = null; // buddy id whose bubble is taking typed input

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.append(e);
  return e;
}

// ---------- buddies ----------

function makeView(d) {
  const { hue, shape } = slotStyle(d.slot);
  const root = el("div", "buddy", layer);
  root.style.setProperty("--h", hue);
  const wrap = el("div", "wrap", root);
  el("div", "halo", wrap);
  const body = el("div", "body " + shape, wrap);
  el("div", "core", body);
  const orbit = el("div", "orbit", wrap);
  for (let i = 0; i < 3; i++) el("i", "", orbit);

  const bubble = el("div", "bubble", layer);
  bubble.style.setProperty("--h", hue);
  const who = el("div", "who", bubble);
  const text = el("div", "text", bubble);
  const input = el("input", "input", bubble);
  input.spellcheck = false;
  input.placeholder = "Ask me something…";
  const hint = el("div", "hint", bubble);
  hint.textContent = "Enter to send · Tab next buddy · Esc cancel";

  const v = {
    id: d.id, data: d, root, body, bubble, who, text, input,
    p: { x: d.x, y: d.y }, vel: { x: 0, y: 0 }, t: { x: d.x, y: d.y }, moving: false,
    sayTimer: 0, typeTimer: 0, speaking: false, status: "",
  };
  // Docked buddies fly in from the right edge; one that arrives mid-task pops in where it is.
  if (d.mode === "home") {
    v.p = { x: innerWidth + 40, y: d.y };
    v.moving = true;
  }
  root.classList.add("pop");
  body.addEventListener("click", () => window.hub.send("click-buddy", v.id));
  input.addEventListener("keydown", (e) => onInputKey(v, e));
  input.addEventListener("blur", () => inputFor === v.id && closeInput(v, false));
  return v;
}

function sync(list) {
  const seen = new Set();
  for (const d of list) {
    seen.add(d.id);
    let v = views.get(d.id);
    if (!v) views.set(d.id, (v = makeView(d)));
    if (d.x !== v.t.x || d.y !== v.t.y) {
      v.t = { x: d.x, y: d.y };
      v.moving = true;
    }
    if (v.moving) kick();
    if (d.mode === "home" && v.data.mode === "point" && inputFor !== v.id) hideBubble(v);
    v.data = d;
    v.root.dataset.state = d.state;
    v.root.classList.toggle("listening", d.listening);
  }
  for (const v of [...views.values()]) if (!seen.has(v.id)) leave(v);
  kick(); // at least one frame, so new buddies get placed
}

function leave(v) {
  views.delete(v.id);
  if (inputFor === v.id) closeInput(v, false);
  clearHighlights(v.id);
  hideBubble(v);
  v.root.classList.add("leaving");
  setTimeout(() => { v.root.remove(); v.bubble.remove(); }, 420);
}

// ---------- motion: a slightly bouncy spring, stretched along the direction of travel ----------

// The loop only runs while something moves or a bubble is changing size, so an idle overlay costs nothing.
const STIFFNESS = 170, DAMPING = 19;
let last = performance.now();
let running = false;
let awakeUntil = 0;
function kick(ms = 600) {
  awakeUntil = Math.max(awakeUntil, performance.now() + ms);
  if (running) return;
  running = true;
  last = performance.now();
  requestAnimationFrame(frame);
}
function frame(now) {
  const dt = Math.min(0.032, (now - last) / 1000);
  last = now;
  for (const v of views.values()) {
    if (v.moving) {
      v.vel.x += (STIFFNESS * (v.t.x - v.p.x) - DAMPING * v.vel.x) * dt;
      v.vel.y += (STIFFNESS * (v.t.y - v.p.y) - DAMPING * v.vel.y) * dt;
      v.p.x += v.vel.x * dt;
      v.p.y += v.vel.y * dt;
      if (Math.hypot(v.t.x - v.p.x, v.t.y - v.p.y) < 0.4 && Math.hypot(v.vel.x, v.vel.y) < 6) {
        v.p = { ...v.t };
        v.vel = { x: 0, y: 0 };
        v.moving = false;
        if (v.data.mode === "point") ripple(v);
      }
    }
    const speed = Math.hypot(v.vel.x, v.vel.y);
    const angle = Math.atan2(v.vel.y, v.vel.x);
    const stretch = 1 + Math.min(speed / 1600, 0.5);
    v.root.style.transform = `translate(${v.p.x}px, ${v.p.y}px)`;
    v.body.style.transform = speed > 1 ? `rotate(${angle}rad) scale(${stretch}, ${1 / stretch}) rotate(${-angle}rad)` : "";
    placeBubble(v);
  }
  if ([...views.values()].some((v) => v.moving) || now < awakeUntil) requestAnimationFrame(frame);
  else running = false;
}

function ripple(v) {
  const r = el("div", "ripple", layer);
  r.style.setProperty("--h", slotStyle(v.data.slot).hue);
  r.style.left = v.p.x + "px";
  r.style.top = v.p.y + "px";
  setTimeout(() => r.remove(), 750);
}

// ---------- speech ----------

// Keep the bubble next to its buddy and fully on screen: above if there is room, otherwise below.
function placeBubble(v) {
  if (!v.bubble.classList.contains("show")) return;
  const bw = v.bubble.offsetWidth, bh = v.bubble.offsetHeight;
  let x = v.p.x > innerWidth / 2 ? v.p.x + 18 - bw : v.p.x - 18;
  let y = v.p.y - 30 - bh;
  if (y < 8) y = v.p.y + 30;
  x = Math.max(8, Math.min(innerWidth - bw - 8, x));
  y = Math.max(8, Math.min(innerHeight - bh - 8, y));
  v.bubble.style.left = x + "px";
  v.bubble.style.top = y + "px";
}

function say(v, text, ms, who) {
  clearTimeout(v.sayTimer);
  clearInterval(v.typeTimer);
  if (inputFor === v.id) return; // never clobber what the user is typing
  if (!text) return hideBubble(v);
  v.speaking = true;
  v.who.textContent = who ?? v.data.name;
  v.text.textContent = "";
  v.bubble.classList.remove("status");
  v.bubble.classList.add("show");
  // Type it out; long messages type faster so they never take more than about a second and a half.
  const step = Math.max(6, Math.min(26, 1400 / text.length));
  let i = 0;
  v.typeTimer = setInterval(() => {
    i += step < 10 ? 2 : 1;
    v.text.textContent = text.slice(0, i);
    if (i >= text.length) clearInterval(v.typeTimer);
  }, step);
  kick(text.length * step + 400);
  if (ms) v.sayTimer = setTimeout(() => hideBubble(v), ms + text.length * step);
}

// Speech ended: fall back to the status line if the agent is still working, else hide.
function hideBubble(v) {
  clearTimeout(v.sayTimer);
  clearInterval(v.typeTimer);
  v.speaking = false;
  if (v.status && views.has(v.id)) showStatus(v);
  else v.bubble.classList.remove("show", "status");
}

// "Looking at your screen…" while the agent works. Speech and typing always take priority.
function showStatus(v) {
  if (inputFor === v.id || v.speaking) return;
  v.who.textContent = v.data.name;
  v.text.textContent = v.status;
  v.bubble.classList.add("show", "status");
  kick();
}

function setStatus(v, text) {
  v.status = text;
  if (text) showStatus(v);
  else if (v.bubble.classList.contains("status") && !v.speaking) v.bubble.classList.remove("show", "status");
}

// ---------- typing to a buddy ----------

function openInput(v, carry = "") {
  if (!v) return;
  const prev = inputFor !== null ? views.get(inputFor) : null;
  if (prev && prev !== v) prev.bubble.classList.remove("typing", "show");
  inputFor = v.id;
  clearTimeout(v.sayTimer);
  clearInterval(v.typeTimer);
  v.who.textContent = "To " + v.data.name;
  v.bubble.classList.add("show", "typing");
  kick();
  v.input.value = carry;
  v.input.focus();
}

function closeInput(v, sent) {
  if (inputFor !== v.id) return;
  inputFor = null;
  v.bubble.classList.remove("typing");
  if (!sent) hideBubble(v);
  window.hub.send("close-input");
}

function onInputKey(v, e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeInput(v, false);
  } else if (e.key === "Tab") {
    e.preventDefault();
    const ids = [...views.keys()];
    if (ids.length < 2) return;
    const next = views.get(ids[(ids.indexOf(v.id) + (e.shiftKey ? ids.length - 1 : 1)) % ids.length]);
    const carry = v.input.value;
    inputFor = null; // switch without handing focus back
    v.bubble.classList.remove("typing", "show");
    openInput(next, carry);
  } else if (e.key === "Enter" && v.input.value.trim()) {
    e.preventDefault();
    const text = v.input.value.trim();
    window.hub.send("send-message", { id: v.id, text });
    closeInput(v, true);
    say(v, text, 2500, "You → " + v.data.name);
  }
}

// ---------- highlights ----------

function addHighlight(d) {
  const box = el("div", "hl", layer);
  box.style.setProperty("--h", slotStyle(d.slot).hue);
  Object.assign(box.style, { left: d.x + "px", top: d.y + "px", width: d.w + "px", height: d.h + "px" });
  el("span", "", box).textContent = d.label || "";
  if (!highlights.has(d.id)) highlights.set(d.id, []);
  highlights.get(d.id).push(box);
}

function clearHighlights(id) {
  for (const box of highlights.get(id) ?? []) box.remove();
  highlights.delete(id);
}

// ---------- hovering: the overlay is click-through except over a buddy ----------

let hovering = false;
addEventListener("mousemove", (e) => {
  let over = false;
  for (const v of views.values()) if (Math.hypot(e.clientX - v.p.x, e.clientY - v.p.y) < 22) over = true;
  if (over !== hovering && inputFor === null) {
    hovering = over;
    window.hub.send("hover", over);
  }
});

// ---------- messages from the hub ----------

window.hub.on("buddies", sync);
window.hub.on("say", (d) => { const v = views.get(d.id); if (v) say(v, d.text, d.ms); });
window.hub.on("highlight", addHighlight);
window.hub.on("status", (d) => { const v = views.get(d.id); if (v) setStatus(v, d.text); });
window.hub.on("clear-buddy", (d) => {
  clearHighlights(d.id);
  const v = views.get(d.id);
  if (v && inputFor !== v.id) hideBubble(v);
});
window.hub.on("open-input", (d) => openInput(views.get(d.id) ?? [...views.values()][0]));
window.hub.on("init", () => {});
