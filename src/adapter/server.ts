// The per-session adapter. Claude Code starts one per session over stdio. It lists the buddy tools,
// starts or finds the shared hub, registers this session's buddy, and relays each tool call.
// When the session ends Claude Code kills this process, the socket closes, and the hub removes the buddy.
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { HubClient } from "./hub-client.js";

const hub = new HubClient();
let buddyName: string | undefined;
hub.onClose = () => {
  buddyName = undefined;
};

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }], isError: true });
const image = (data: string, note: string): CallToolResult => ({
  content: [
    { type: "image", data, mimeType: "image/jpeg" },
    { type: "text", text: note },
  ],
});

// Every tool except activate needs a buddy; turn hub errors into readable tool errors.
function withBuddy<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    if (!buddyName || !hub.connected) return fail("Your buddy is not on screen. Call activate first.");
    try {
      return await fn(args);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  };
}

// Looking (screenshot, zoom, cursor, calibrate) needs no buddy on screen: connect to the hub, starting it if needed.
function withHub<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      await hub.connect(() => {});
      return await fn(args);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  };
}

// Screenshots go through the hub's scene cache, which may answer "nothing changed" or send only the changed part.
async function screenshot(opts: { maxDim?: number; display?: number; fresh?: boolean } = {}): Promise<CallToolResult> {
  const r = await hub.request("capture", opts);
  const where = `display ${r.display} of ${r.displays}`;
  if (r.kind === "same") {
    const pts = r.points.length
      ? " You pointed at: " + r.points.map((p) => `${p.label ? `"${p.label}" ` : ""}(${p.x}, ${p.y})`).join(", ") + "."
      : "";
    return text(
      `No change since your screenshot #${r.n} of ${where} (taken ${r.ageSec}s ago), so no new image. Keep using #${r.n}: ` +
        `coordinates are in its pixels.${pts} (If you no longer have that image, call screenshot with fresh: true.)`
    );
  }
  if (r.kind === "region") {
    return image(
      r.data,
      `Only part of your screenshot #${r.n} (${where}) changed. This image is that part at the same scale: ` +
        `x ${r.x}–${r.x + r.width}, y ${r.y}–${r.y + r.height} of #${r.n}. Add (${r.x}, ${r.y}) to a position in this image ` +
        `to get #${r.n} coordinates, which point_at and highlight use. The rest of #${r.n} is unchanged.`
    );
  }
  return image(
    r.data,
    `Screenshot #${r.n}, ${where}, ${r.width}x${r.height}px. Coordinates for point_at, highlight and zoom are in this image's pixels.`
  );
}

const server = new McpServer(
  { name: "screen-buddy", version: "0.3.0" },
  {
    instructions:
      "Screen Buddy: a small glowing companion on the user's screen that belongs to this session. " +
      "You can always look at the user's screen with screenshot (and zoom for detail), buddy or not: do that instead " +
      "of asking them to upload a screenshot. The buddy itself is off until you call activate (\"activate screen buddy\"). " +
      "Once active: point_at/highlight to show, say to talk, " +
      "and call next_event in a loop to hear the user (they press Option+Shift+Space or click your buddy to type). " +
      "follow(true) makes next_event also report when the screen changes so you can keep up as they click around.",
  }
);

server.registerTool(
  "activate",
  {
    description:
      "Turn on Screen Buddy: put this session's buddy on the user's screen (starts the shared overlay if needed). Call when " +
      "the user says \"activate screen buddy\", or asks you to show up, watch, or help on screen. Safe to call again.",
    inputSchema: { name: z.string().max(32).optional().describe("Name shown on your buddy (default: the project folder)") },
  },
  async ({ name }) => {
    try {
      const notes: string[] = [];
      await hub.connect((m) => notes.push(m));
      const r = await hub.request("hello", { name: name || path.basename(process.cwd()), pid: process.pid });
      buddyName = r.name;
      return text(`${notes.join(" ")} Your buddy "${r.name}" is on screen. Call next_event in a loop to listen.`.trim());
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }
);

server.registerTool(
  "deactivate",
  {
    description:
      "Turn off Screen Buddy for this session (\"screen buddy off\", \"go away\"): removes the buddy. Stop calling next_event afterwards.",
  },
  withBuddy(async () => {
    await hub.request("bye", {});
    hub.close();
    buddyName = undefined;
    return text("Your buddy left the screen.");
  })
);

server.registerTool(
  "screenshot",
  {
    description:
      "Look at the user's screen (the display under their mouse by default). Works without activating Screen Buddy: use it " +
      "whenever the user says \"look at my screen\", \"see this?\", \"what's this error\" and similar, instead of asking for " +
      "an uploaded screenshot. Cached: if nothing changed since a screenshot " +
      "you already have, you get a note instead of an image; if only part changed, you get just that part. " +
      "point_at, highlight and zoom use the current screenshot's pixel coordinates.",
    inputSchema: {
      fresh: z.boolean().optional().describe("Always send a whole new image (skip the cache)"),
      display: z.number().int().min(1).optional().describe("Display number (1 is the main display). Default: the one under the mouse"),
      maxDim: z.number().int().min(320).max(2560).optional().describe("Longest side in px (default 1280)"),
    },
  },
  withHub(async ({ display, maxDim, fresh }) => screenshot({ display, maxDim, fresh }))
);

server.registerTool(
  "zoom",
  {
    description:
      "Look closer at a region of your last screenshot (or zoom), in its pixel coordinates, at full resolution, to read " +
      "small text or aim at small things. Works without activating Screen Buddy. " +
      "Use before pointing at small things. Afterwards, coordinates refer to the zoomed image.",
    inputSchema: { x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() },
  },
  withHub(async (r) => {
    const img = await hub.request("zoom", r);
    return image(img.data, `Zoomed image ${img.width}x${img.height}px. point_at and highlight now use these pixels.`);
  })
);

server.registerTool(
  "point_at",
  {
    description: "Fly your buddy to (x, y) in your last image's pixels, with an optional label in its speech bubble.",
    inputSchema: { x: z.number(), y: z.number(), label: z.string().max(120).optional() },
  },
  withBuddy(async (a) => {
    const r = await hub.request("point", a);
    return text(`Pointing at screen point (${r.screenX}, ${r.screenY}).${r.warning ? " " + r.warning : ""}`);
  })
);

server.registerTool(
  "highlight",
  {
    description: "Draw a glowing box (in your buddy's colour) around a region of your last image, with an optional label.",
    inputSchema: {
      x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive(),
      label: z.string().max(80).optional(),
    },
  },
  withBuddy(async (a) => {
    await hub.request("highlight", a);
    return text("Highlighted.");
  })
);

server.registerTool(
  "say",
  {
    description: "Show text in your buddy's speech bubble. Use it to answer messages from next_event. Keep it short.",
    inputSchema: {
      text: z.string().min(1).max(400),
      seconds: z.number().min(1).max(120).optional().describe("How long it stays (default scales with length)"),
    },
  },
  withBuddy(async ({ text: t, seconds }) => {
    await hub.request("say", { text: t, ms: (seconds ?? Math.max(5, t.length / 12)) * 1000 });
    return text("Said.");
  })
);

server.registerTool(
  "clear",
  { description: "Send your buddy back to its dock and remove its speech bubble and highlights." },
  withBuddy(async () => {
    await hub.request("clear", {});
    return text("Cleared.");
  })
);

server.registerTool(
  "next_event",
  {
    description:
      "Wait for something to happen: the user typing to your buddy, or (with follow on) the screen changing. " +
      "Both come with the current screen attached (as a screenshot, a changed region, or a no-change note), so you can " +
      "usually answer or point straight away without calling screenshot. Call it in a loop.",
    inputSchema: { timeoutSeconds: z.number().min(1).max(120).optional().describe("Default 30") },
  },
  withBuddy(async ({ timeoutSeconds }) => {
    const ms = (timeoutSeconds ?? 30) * 1000;
    const { event } = await hub.request("next_event", { timeoutMs: ms }, ms + 10_000);
    if (!event) return text("Nothing yet. Call next_event again to keep listening.");
    // Include the screen right away: the agent almost always needs to look, and this saves a round trip.
    const shot = await screenshot(event.type === "screen_changed" ? { display: event.display } : {}).catch(
      (e): CallToolResult => text(`(Could not capture the screen: ${e instanceof Error ? e.message : e})`)
    );
    const intro = event.type === "message" ? `The user says: ${event.text}\nTheir screen right now:` : "The screen changed. Here is what it looks like now:";
    shot.content.unshift({ type: "text", text: intro });
    return shot;
  })
);

server.registerTool(
  "follow",
  {
    description:
      "Turn follow-along on or off. While on, next_event also returns a fresh screenshot whenever the screen changes " +
      "and settles (for example as the user clicks through an app). Each change costs a screenshot, so turn it off when done.",
    inputSchema: { on: z.boolean() },
  },
  withBuddy(async ({ on }) => {
    await hub.request("follow", { on });
    return text(on ? "Following: next_event will report screen changes." : "Stopped following.");
  })
);

server.registerTool(
  "get_cursor_position",
  { description: "Where the user's mouse is, in your last image's pixels (or screen points if you have not taken one)." },
  withHub(async () => text(JSON.stringify(await hub.request("cursor", {}))))
);

server.registerTool(
  "calibrate",
  {
    description:
      "Check that screenshot pixels map exactly onto the screen: flashes markers at known spots, captures, and reports the error.",
  },
  withHub(async () => text((await hub.request("calibrate", {}, 20_000)).report))
);

await server.connect(new StdioServerTransport());
