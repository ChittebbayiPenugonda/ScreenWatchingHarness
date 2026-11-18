// Shared between the per-session adapter and the hub.
// Transport: newline-delimited JSON over a Unix socket that only this user can open.
//   adapter -> hub: { id, op, ...args }
//   hub -> adapter: { id, ok: true, result } | { id, ok: false, error }
import { homedir } from "node:os";
import { join } from "node:path";

export const HUB_DIR = join(homedir(), "Library", "Application Support", "screen-buddy");
export const SOCKET_PATH = join(HUB_DIR, "hub.sock"); // the directory is private to this user
export const LOG_PATH = join(HUB_DIR, "hub.log");
export const ELECTRON_VERSION = "33.4.11";

export type Ops = {
  hello: { args: { name: string; pid: number }; result: { id: number; name: string } };
  bye: { args: {}; result: {} };
  capture: { args: { maxDim?: number; display?: number; fresh?: boolean }; result: Capture };
  zoom: { args: Rect & { maxDim?: number }; result: Image & { n: number } };
  point: { args: { x: number; y: number; label?: string }; result: { screenX: number; screenY: number; warning?: string } };
  highlight: { args: Rect & { label?: string }; result: {} };
  say: { args: { text: string; ms: number }; result: {} };
  clear: { args: {}; result: {} };
  next_event: { args: { timeoutMs: number }; result: { event: BuddyEvent | null } };
  follow: { args: { on: boolean }; result: {} };
  cursor: { args: {}; result: { x: number; y: number; space: "image" | "screen" } };
  calibrate: { args: {}; result: { report: string; maxError: number } };
};

export type Op = keyof Ops;
export type Rect = { x: number; y: number; width: number; height: number };
export type Image = { data: string; width: number; height: number };
// The scene cache answers a screenshot request in one of three ways:
//   full:   a new image (screenshot #n)
//   region: only part of screenshot #n changed; the image is that part, at the same scale, with its top-left at (x, y)
//   same:   nothing changed since screenshot #n, so no image is sent
export type Capture = { n: number; display: number; displays: number } & (
  | ({ kind: "full" } & Image)
  | ({ kind: "region"; x: number; y: number } & Image)
  | { kind: "same"; ageSec: number; points: { label?: string; x: number; y: number }[] }
);
export type BuddyEvent = { type: "message"; text: string } | { type: "screen_changed"; display: number };

export type Request = { id: number; op: Op } & Record<string, unknown>;
export type Response = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
