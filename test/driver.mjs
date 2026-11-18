// Drive buddies by hand, as if you were the agent. Starts one fake session per name and runs tool calls
// you drop into <dir>/cmd.json as {"session": "alpha", "tool": "point_at", "args": {...}}.
// Results land in <dir>/out.json, with images saved next to it.
//   node test/driver.mjs /some/dir
// Set SCREEN_BUDDY_SHOW_IN_CAPTURE=1 (before the hub starts) to see the buddies in screenshots.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node test/driver.mjs <dir>");
const sessions = new Map();
let n = 0;

async function session(name) {
  if (sessions.has(name)) return sessions.get(name);
  const client = new Client({ name: `driver-${name}`, version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: ["dist/server.js"], env: { ...process.env } }));
  sessions.set(name, client);
  return client;
}

for (;;) {
  const cmdPath = join(dir, "cmd.json");
  if (existsSync(cmdPath)) {
    const cmd = JSON.parse(readFileSync(cmdPath, "utf8"));
    rmSync(cmdPath);
    let out;
    try {
      if (cmd.tool === "quit") break;
      if (cmd.tool === "close") {
        await sessions.get(cmd.session)?.close();
        sessions.delete(cmd.session);
        out = { text: "closed" };
      } else {
        const r = await (await session(cmd.session)).callTool({ name: cmd.tool, arguments: cmd.args ?? {} });
        const images = r.content.filter((c) => c.type === "image").map((c) => {
          const file = join(dir, `shot-${++n}.jpg`);
          writeFileSync(file, Buffer.from(c.data, "base64"));
          return file;
        });
        out = { error: !!r.isError, text: r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), images };
      }
    } catch (e) {
      out = { error: true, text: String(e) };
    }
    writeFileSync(join(dir, "out.tmp"), JSON.stringify(out, null, 2));
    renameSync(join(dir, "out.tmp"), join(dir, "out.json"));
  }
  await new Promise((r) => setTimeout(r, 150));
}
for (const c of sessions.values()) await c.close();
process.exit(0);
