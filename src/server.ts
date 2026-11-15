import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Bridge } from "./bridge.js";
import { captureScreen, type Capture } from "./screen.js";

const here = dirname(fileURLToPath(import.meta.url));
const bridge = new Bridge();
await bridge.start();

// The overlay is a child process that connects back to the bridge. It only runs between
// activate() and deactivate(); the server itself stays up the whole session.
const electronPath = createRequire(import.meta.url)("electron") as unknown as string;
// VS Code sets ELECTRON_RUN_AS_NODE, which would make Electron behave like plain Node.
const { ELECTRON_RUN_AS_NODE: _, ...overlayEnv } = process.env;
let overlayProc: ChildProcess | undefined;

async function activate(): Promise<string> {
  if (overlayProc && bridge.connected) return "Helper is already active.";
  if (!overlayProc) {
    const proc = spawn(electronPath, [join(here, "..", "overlay")], { stdio: "ignore", env: overlayEnv });
    proc.on("exit", () => {
      if (overlayProc === proc) overlayProc = undefined; // closed by the user or crashed
    });
    overlayProc = proc;
  }
  await bridge.waitForOverlay(15000);
  return "Helper is active on the user's screen.";
}

async function deactivate(): Promise<string> {
  const proc = overlayProc;
  if (!proc) return "Helper was not active.";
  overlayProc = undefined;
  await new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
    proc.kill();
    setTimeout(resolve, 2000);
  });
  return "Helper is gone from the screen.";
}

// Every tool that touches the overlay goes through this.
async function overlay() {
  if (!overlayProc) throw new Error("The helper is not active. Call activate first.");
  return bridge.waitForOverlay();
}

process.on("exit", () => overlayProc?.kill());
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

let lastCapture: Capture | undefined;

// Convert coordinates in the last screenshot's pixel space to screen points.
async function toScreen(x: number, y: number) {
  const screen = await overlay();
  const w = lastCapture?.width ?? screen.width;
  const h = lastCapture?.height ?? screen.height;
  return { x: (x * screen.width) / w, y: (y * screen.height) / h };
}

// Messages the user types into the helper (via the global shortcut) wait here for the agent.
const inbox: string[] = [];
let waiter: ((text: string) => void) | undefined;
bridge.on("user_message", (text: string) => {
  if (waiter) {
    waiter(text);
    waiter = undefined;
  } else inbox.push(text);
});

const server = new McpServer(
  { name: "screen-watching-harness", version: "0.1.0" },
  {
    instructions:
      "A small helper character can live on the user's screen. It is OFF until you call activate, and is removed by deactivate. " +
      "Once active, the user can type to you through it: call wait_for_message in a loop to listen; reply with say(). " +
      "Use screenshot + point_at to show things.",
  }
);

server.tool(
  "activate",
  "Show the helper on the user's screen (starts the overlay). Call this when the user asks you to wake up, appear, or start watching. Safe to call if already active.",
  {},
  async () => ({ content: [{ type: "text", text: await activate() }] })
);

server.tool(
  "deactivate",
  "Remove the helper from the user's screen (stops the overlay). Call this when the user asks you to go away or stop watching. Stop calling wait_for_message afterwards.",
  {},
  async () => ({ content: [{ type: "text", text: await deactivate() }] })
);

server.tool(
  "screenshot",
  "Capture the user's main display. Returns a downscaled image. Coordinates for point_at/highlight are in this image's pixel space.",
  { maxDim: z.number().int().min(320).max(2560).optional().describe("Longest side in px (default 1280)") },
  async ({ maxDim }) => {
    lastCapture = await captureScreen(maxDim ?? 1280);
    return {
      content: [
        { type: "image", data: lastCapture.base64, mimeType: "image/jpeg" },
        { type: "text", text: `Image is ${lastCapture.width}x${lastCapture.height}px. Use this pixel space for point_at/highlight.` },
      ],
    };
  }
);

server.tool(
  "point_at",
  "Move a visible pointer on the user's screen to (x, y) in the last screenshot's pixel space, with an optional label.",
  {
    x: z.number(),
    y: z.number(),
    label: z.string().max(80).optional(),
  },
  async ({ x, y, label }) => {
    const p = await toScreen(x, y);
    bridge.send({ type: "point", x: p.x, y: p.y, label });
    return { content: [{ type: "text", text: `Pointing at (${Math.round(x)}, ${Math.round(y)})` }] };
  }
);

server.tool(
  "highlight",
  "Draw a rectangle around a region (last screenshot's pixel space) with an optional label.",
  {
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    label: z.string().max(80).optional(),
  },
  async ({ x, y, width, height, label }) => {
    const a = await toScreen(x, y);
    const b = await toScreen(x + width, y + height);
    bridge.send({ type: "highlight", x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y, label });
    return { content: [{ type: "text", text: "Highlighted region" }] };
  }
);

server.tool(
  "say",
  "Show a speech bubble next to the helper on the user's screen. Use it to reply to messages from wait_for_message.",
  {
    text: z.string().max(400),
    seconds: z.number().min(1).max(60).optional().describe("How long to show it (default scales with length)"),
  },
  async ({ text, seconds }) => {
    await overlay();
    bridge.send({ type: "say", text, ms: (seconds ?? Math.max(5, text.length / 12)) * 1000 });
    return { content: [{ type: "text", text: "Said it" }] };
  }
);

server.tool(
  "wait_for_message",
  "Wait for the user to type a message to the helper (they press the shortcut, default Option+Shift+Space). " +
    "Returns the message, or says none arrived so you can call again. Call this in a loop to stay available.",
  { timeoutSeconds: z.number().min(1).max(60).optional().describe("Default 30") },
  async ({ timeoutSeconds }) => {
    await overlay();
    if (inbox.length) return { content: [{ type: "text", text: inbox.shift()! }] };
    bridge.send({ type: "status", listening: true });
    const text = await new Promise<string | undefined>((resolve) => {
      const t = setTimeout(() => {
        waiter = undefined;
        resolve(undefined);
      }, (timeoutSeconds ?? 30) * 1000);
      waiter = (msg) => {
        clearTimeout(t);
        resolve(msg);
      };
    });
    if (bridge.connected) bridge.send({ type: "status", listening: false });
    return { content: [{ type: "text", text: text ?? "(no message yet — call wait_for_message again to keep listening)" }] };
  }
);

server.tool("clear", "Send the helper back to its resting spot and remove the speech bubble and any highlights.", {}, async () => {
  await overlay();
  bridge.send({ type: "clear" });
  return { content: [{ type: "text", text: "Cleared" }] };
});

server.tool(
  "get_cursor_position",
  "Get the user's mouse position in the last screenshot's pixel space (take a screenshot first).",
  {},
  async () => {
    const screen = await overlay();
    const r = await bridge.request<{ x: number; y: number }>({ type: "getCursor" });
    const w = lastCapture?.width ?? screen.width;
    const h = lastCapture?.height ?? screen.height;
    const x = Math.round((r.x * w) / screen.width);
    const y = Math.round((r.y * h) / screen.height);
    return { content: [{ type: "text", text: JSON.stringify({ x, y }) }] };
  }
);

await server.connect(new StdioServerTransport());
