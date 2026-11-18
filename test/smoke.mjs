// End-to-end smoke test: two fake Claude sessions start adapters over stdio, race to start the hub,
// get their own buddies, call tools, and leave. Run after `npm run build`. Watch your screen while it runs.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG = join(homedir(), "Library", "Application Support", "screen-buddy", "hub.log");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Main hub processes only (Electron's GPU/renderer helpers carry --type=...).
const hubPids = () =>
  execSync("pgrep -fl 'dist/hub' | grep -v -- '--type=' || true").toString().trim().split("\n").filter(Boolean).map((l) => l.split(" ")[0]);
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

async function session(name) {
  const client = new Client({ name: `smoke-${name}`, version: "0" });
  const transport = new StdioClientTransport({ command: "node", args: ["dist/server.js"], stderr: "inherit" });
  await client.connect(transport);
  const call = async (tool, args = {}) => {
    const r = await client.callTool({ name: tool, arguments: args });
    return { error: !!r.isError, text: r.content.filter((c) => c.type === "text").map((c) => c.text).join(" "), images: r.content.filter((c) => c.type === "image") };
  };
  return { client, call, close: () => client.close() };
}

check("no hub running before the test", hubPids().length === 0, hubPids().join(","));

const a = await session("alpha");
const b = await session("beta");
const tools = (await a.client.listTools()).tools.map((t) => t.name);
check("adapter lists tools without a hub", tools.length === 12 && hubPids().length === 0, tools.join(", "));

const early = await a.call("say", { text: "hi" });
check("tools refuse before activate", early.error && /activate/.test(early.text), early.text);

// Both sessions activate at the same moment: exactly one hub must win.
const [ra, rb] = await Promise.all([a.call("activate", { name: "alpha" }), b.call("activate", { name: "beta" })]);
check("session A activates", !ra.error, ra.text);
check("session B activates", !rb.error, rb.text);
await sleep(1500);
check("exactly one hub process", hubPids().length === 1, hubPids().join(","));

check("say works", !(await a.call("say", { text: "Hello from alpha! I'm the pink one.", seconds: 6 })).error);
check("say works for B", !(await b.call("say", { text: "And I'm beta, the teal one.", seconds: 6 })).error);
await sleep(2500);

const noShot = await a.call("point_at", { x: 10, y: 10 });
check("point_at needs a screenshot first", noShot.error && /screenshot/i.test(noShot.text), noShot.text);

const shot = await a.call("screenshot");
if (shot.error) {
  check("screenshot (needs Screen Recording for Electron)", false, shot.text);
} else {
  check("screenshot returns an image", shot.images.length === 1, shot.text);
  const m = /(\d+)x(\d+)px/.exec(shot.text);
  const [w, h] = [Number(m[1]), Number(m[2])];
  check("point_at centre", !(await a.call("point_at", { x: w / 2, y: h / 2, label: "Centre of the screen" })).error);
  await sleep(1500);
  check("highlight", !(await b.call("screenshot")).error && !(await b.call("highlight", { x: w * 0.1, y: h * 0.1, width: w * 0.2, height: h * 0.15, label: "beta's box" })).error);
  await sleep(1500);
  const z = await a.call("zoom", { x: w / 2 - 100, y: h / 2 - 60, width: 200, height: 120 });
  check("zoom", !z.error && z.images.length === 1, z.text);
  const cal = await a.call("calibrate");
  check("calibrate", !cal.error && /Calibrated/.test(cal.text), cal.text.replace(/\n/g, " | "));
}

const cur = await a.call("get_cursor_position");
check("cursor position", !cur.error, cur.text);

const ev = await a.call("next_event", { timeoutSeconds: 2 });
check("next_event times out quietly", !ev.error && /Nothing yet/.test(ev.text), ev.text);

check("clear", !(await a.call("clear")).error);
await sleep(1200);

// Session B ends without saying goodbye (like closing Claude): its buddy must leave on its own.
await b.close();
await sleep(1000);
check("hub notices a session ended", readFileSync(LOG, "utf8").split("\n").slice(-30).some((l) => /beta\) left: session ended/.test(l)));

const off = await a.call("deactivate");
check("deactivate", !off.error, off.text);
await a.close();

console.log("Waiting for the hub to quit when idle (30 s)…");
await sleep(33_000);
check("hub quits when no buddies are left", hubPids().length === 0, hubPids().join(","));

console.log(failures ? `\n${failures} check(s) failed. Hub log: ${LOG}` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
