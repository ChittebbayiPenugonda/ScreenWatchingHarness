// The adapter's connection to the hub: finds it, starts it if needed, and sends requests over the socket.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { HUB_DIR, SOCKET_PATH, ELECTRON_VERSION, type Op, type Ops, type Response } from "../shared/protocol.js";

const run = promisify(execFile);
// dist/server.js -> plugin root
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export class HubClient {
  private sock?: net.Socket;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  onClose?: () => void;

  get connected() {
    return !!this.sock && !this.sock.destroyed;
  }

  // Connect to the running hub, or start one and wait for it.
  async connect(log: (msg: string) => void) {
    if (this.connected) return;
    try {
      return await this.open();
    } catch {}
    log("Starting the buddy hub…");
    await launchHub(log);
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        return await this.open();
      } catch (e) {
        if (Date.now() > deadline) throw new Error(`The buddy hub did not start. See ${path.join(HUB_DIR, "hub.log")}. (${e})`);
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  private open() {
    return new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(SOCKET_PATH);
      sock.once("connect", () => {
        sock.off("error", reject);
        this.attach(sock);
        resolve();
      });
      sock.once("error", reject);
    });
  }

  private attach(sock: net.Socket) {
    this.sock = sock;
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const msg = JSON.parse(this.buf.slice(0, i)) as Response;
        this.buf = this.buf.slice(i + 1);
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error));
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      this.sock = undefined;
      this.buf = "";
      for (const p of this.pending.values()) p.reject(new Error("The buddy hub went away; call activate to bring your buddy back."));
      this.pending.clear();
      this.onClose?.();
    });
  }

  request<K extends Op>(op: K, args: Ops[K]["args"], timeoutMs = 15_000): Promise<Ops[K]["result"]> {
    if (!this.sock || this.sock.destroyed) return Promise.reject(new Error("Not connected to the buddy hub."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The buddy hub did not answer "${op}" in time.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(t), resolve(v)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
      this.sock!.write(JSON.stringify({ id, op, ...args }) + "\n");
    });
  }

  close() {
    this.sock?.end();
  }
}

// Electron comes from the plugin's own node_modules in a dev checkout, otherwise from a runtime
// folder we install it into on first use (an installed plugin has no node_modules).
async function resolveElectron(log: (msg: string) => void): Promise<string> {
  const candidates = [path.join(PLUGIN_ROOT, "package.json"), path.join(HUB_DIR, "runtime", "package.json")];
  for (const c of candidates) {
    try {
      return createRequire(c)("electron") as string;
    } catch {}
  }
  const runtime = path.join(HUB_DIR, "runtime");
  fs.mkdirSync(runtime, { recursive: true });
  if (!fs.existsSync(path.join(runtime, "package.json"))) fs.writeFileSync(path.join(runtime, "package.json"), '{"private":true}\n');
  log(`First run: installing Electron ${ELECTRON_VERSION} into ${runtime} (about 100 MB, one time)…`);
  await run("npm", ["install", "--no-audit", "--no-fund", `electron@${ELECTRON_VERSION}`], { cwd: runtime, timeout: 300_000 });
  return createRequire(path.join(runtime, "package.json"))("electron") as string;
}

async function launchHub(log: (msg: string) => void) {
  const binary = await resolveElectron(log);
  const appDir = path.join(PLUGIN_ROOT, "dist", "hub");
  const extra = process.env.SCREEN_BUDDY_SHOW_IN_CAPTURE === "1" ? ["--show-in-capture"] : [];
  const bundle = binary.match(/^(.*?\.app)\/Contents\/MacOS\//)?.[1];
  if (bundle) {
    // Launch through LaunchServices so macOS treats the hub as its own app: Screen Recording is then
    // granted once to it, whichever terminal or app the Claude session runs in.
    spawn("open", ["-n", "-g", "-a", bundle, "--args", appDir, ...extra], { detached: true, stdio: "ignore" }).unref();
  } else {
    const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
    spawn(binary, [appDir, ...extra], { detached: true, stdio: "ignore", env }).unref();
  }
}
