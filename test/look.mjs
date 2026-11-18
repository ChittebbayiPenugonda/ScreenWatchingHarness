// Headless check that a session can look at the screen without a buddy. Puts nothing on screen.
//   node test/look.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG = join(homedir(), "Library", "Application Support", "screen-buddy", "hub.log");
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
}

const client = new Client({ name: "look-test", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/server.js"] }));
const call = async (tool, args = {}) => {
  const r = await client.callTool({ name: tool, arguments: args });
  return { error: !!r.isError, text: r.content.filter((c) => c.type === "text").map((c) => c.text).join(" "), images: r.content.filter((c) => c.type === "image").length };
};
const logBefore = readFileSync(LOG, "utf8").length;

const t0 = Date.now();
const shot = await call("screenshot");
check("screenshot works without activate", !shot.error && shot.images === 1, `${Date.now() - t0}ms (includes starting the hub) — ${shot.text.slice(0, 60)}`);

const t1 = Date.now();
const again = await call("screenshot");
check("second screenshot goes through the cache", !again.error && /No change|Only part|Screenshot #/.test(again.text), `${Date.now() - t1}ms — ${again.text.slice(0, 70)}`);

const z = await call("zoom", { x: 0, y: 0, width: 400, height: 200 });
check("zoom works without activate", !z.error && z.images === 1, z.text.slice(0, 60));

const cur = await call("get_cursor_position");
check("cursor works without activate", !cur.error, cur.text);

const pt = await call("point_at", { x: 10, y: 10 });
check("pointing still needs the buddy", pt.error && /activate/.test(pt.text), pt.text);

const newLog = readFileSync(LOG, "utf8").slice(logBefore);
check("no buddy was put on screen", !/joined/.test(newLog));

await client.close();
console.log(failures ? `\n${failures} check(s) failed. Hub log: ${LOG}` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
