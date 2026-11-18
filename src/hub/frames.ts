// Small greyscale frames of each display, and ways to compare them.
//
// Two comparisons, for two jobs:
//  - pixel:     did anything at all change? Used by the scene cache, which must never call a changed screen "unchanged".
//  - layout:    did the layout change? Counts edges that appeared or vanished, and big brightness jumps, but not
//               mild tints, so a button lighting up on hover does not count, while scrolling, navigating,
//               or switching apps and Spaces does.
import { screen, type NativeImage } from "electron";
import { getSources } from "./capture.js";

export type Rect = { x: number; y: number; width: number; height: number };
export type Frame = { displayId: number; bounds: Rect; w: number; h: number; grey: Uint8Array; at: number };
export type Diff = { fraction: number; blocks: number; blockFraction: number; bbox?: Rect };

export const FRAME_WIDTH = 640; // about 2.4 pt per cell on a laptop display
const PIXEL_DELTA = 28;
const EDGE_DELTA = 36;
const FILL_DELTA = 64; // red to white counts, a hover tint does not
const BLOCK = 8; // cells per block side; a block counts as changed when 3+ of its cells changed

export function toFrame(img: NativeImage, displayId: number, bounds: Rect): Frame {
  const { width: w, height: h } = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  const grey = new Uint8Array(w * h);
  for (let i = 0; i < grey.length; i++) grey[i] = (bmp[i * 4] * 29 + bmp[i * 4 + 1] * 150 + bmp[i * 4 + 2] * 77) >> 8;
  return { displayId, bounds, w, h, grey, at: Date.now() };
}

// One frame per display, in a single capture pass (about 270 ms however small).
export async function sampleFrames(): Promise<Map<number, Frame>> {
  const sources = await getSources({ types: ["screen"], thumbnailSize: { width: FRAME_WIDTH, height: FRAME_WIDTH } });
  const out = new Map<number, Frame>();
  for (const s of sources) {
    const d = screen.getAllDisplays().find((x) => String(x.id) === s.display_id);
    if (d && !s.thumbnail.isEmpty()) out.set(d.id, toFrame(s.thumbnail, d.id, d.bounds));
  }
  return out;
}

// Cells covering a rect given in global points (the whole display if omitted).
function cellRange(f: Frame, r?: Rect) {
  if (!r) return { x0: 0, y0: 0, x1: f.w, y1: f.h };
  const kx = f.w / f.bounds.width, ky = f.h / f.bounds.height;
  return {
    x0: Math.max(0, Math.floor((r.x - f.bounds.x) * kx)),
    y0: Math.max(0, Math.floor((r.y - f.bounds.y) * ky)),
    x1: Math.min(f.w, Math.ceil((r.x + r.width - f.bounds.x) * kx)),
    y1: Math.min(f.h, Math.ceil((r.y + r.height - f.bounds.y) * ky)),
  };
}

function compare(a: Frame, b: Frame, region: Rect | undefined, changed: (i: number) => boolean): Diff {
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
      bx0 = Math.min(bx0, i); by0 = Math.min(by0, j); bx1 = Math.max(bx1, i); by1 = Math.max(by1, j);
    }
  }
  const sx = b.bounds.width / b.w, sy = b.bounds.height / b.h;
  const bbox = blocks
    ? {
        x: b.bounds.x + (x0 + bx0 * BLOCK) * sx,
        y: b.bounds.y + (y0 + by0 * BLOCK) * sy,
        width: Math.min(x1 - x0, (bx1 - bx0 + 1) * BLOCK) * sx,
        height: Math.min(y1 - y0, (by1 - by0 + 1) * BLOCK) * sy,
      }
    : undefined;
  return { fraction: n / ((x1 - x0) * (y1 - y0)), blocks, blockFraction: blocks / (bw * bh), bbox };
}

export function pixelDiff(a: Frame, b: Frame, region?: Rect): Diff {
  return compare(a, b, region, (i) => Math.abs(a.grey[i] - b.grey[i]) > PIXEL_DELTA);
}

export function layoutDiff(a: Frame, b: Frame, region?: Rect): Diff {
  const w = b.w;
  return compare(a, b, region, (i) => {
    if (Math.abs(a.grey[i] - b.grey[i]) > FILL_DELTA) return true;
    if (i % w === w - 1 || i + w >= a.grey.length) return false;
    const ea = Math.abs(a.grey[i + 1] - a.grey[i]) + Math.abs(a.grey[i + w] - a.grey[i]);
    const eb = Math.abs(b.grey[i + 1] - b.grey[i]) + Math.abs(b.grey[i + w] - b.grey[i]);
    return Math.abs(ea - eb) > EDGE_DELTA;
  });
}

export function around(x: number, y: number, r: number): Rect {
  return { x: x - r, y: y - r, width: 2 * r, height: 2 * r };
}
