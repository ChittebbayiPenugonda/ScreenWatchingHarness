// Full-resolution screen capture, image <-> screen coordinate transforms, and calibration markers.
import { desktopCapturer, systemPreferences, type Display, type NativeImage } from "electron";

// Maps an image's pixels to global screen points: screen = origin + pixel * scale.
export type Transform = { displayId: number; ox: number; oy: number; sx: number; sy: number };

export function toGlobal(t: Transform, x: number, y: number) {
  return { x: t.ox + x * t.sx, y: t.oy + y * t.sy };
}
export function toImage(t: Transform, gx: number, gy: number) {
  return { x: (gx - t.ox) / t.sx, y: (gy - t.oy) / t.sy };
}

export class PermissionError extends Error {}

// desktopCapturer misbehaves when calls overlap (one can hang for good), so every capture takes a turn,
// and none may take longer than a few seconds.
let queue: Promise<unknown> = Promise.resolve();
export function getSources(opts: Electron.SourcesOptions): Promise<Electron.DesktopCapturerSource[]> {
  const run = () =>
    Promise.race([
      desktopCapturer.getSources(opts),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Screen capture timed out")), 5000)),
    ]);
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

function permissionHint() {
  return (
    "Screen Recording permission is missing for the buddy hub (it shows up as \"Electron\"). " +
    "Open System Settings > Privacy & Security > Screen Recording, turn on Electron, then try again " +
    "(macOS may ask you to quit and reopen it: call deactivate, then activate)."
  );
}

// Full-resolution image of one display, in physical pixels.
export async function grab(display: Display, thumb?: { width: number; height: number }): Promise<NativeImage> {
  const size = thumb ?? {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
  };
  let sources;
  try {
    sources = await getSources({ types: ["screen"], thumbnailSize: size });
  } catch (e) {
    if (e instanceof Error && /timed out/.test(e.message)) throw e;
    // Without Screen Recording permission, macOS refuses the capture and Electron says "Failed to get sources".
    throw new PermissionError(`${permissionHint()} (status: ${systemPreferences.getMediaAccessStatus("screen")}; ${e})`);
  }
  const src = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined);
  const status = systemPreferences.getMediaAccessStatus("screen");
  if (!src || src.thumbnail.isEmpty() || status === "denied" || status === "restricted") {
    throw new PermissionError(permissionHint());
  }
  return src.thumbnail;
}

export function fitTo(img: NativeImage, maxDim: number, minDim = 0): NativeImage {
  const { width, height } = img.getSize();
  const long = Math.max(width, height);
  const target = Math.max(Math.min(long, maxDim), Math.min(minDim, maxDim));
  if (target === long) return img;
  const k = target / long;
  return img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: "best" });
}

export function encode(img: NativeImage) {
  const { width, height } = img.getSize();
  return { data: img.toJPEG(72).toString("base64"), width, height };
}

// Finds the centre of the magenta calibration marker nearest an expected pixel position.
export function findMarker(img: NativeImage, ex: number, ey: number, radius: number) {
  const { width, height } = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  let sx = 0, sy = 0, n = 0;
  const x0 = Math.max(0, Math.round(ex - radius)), x1 = Math.min(width - 1, Math.round(ex + radius));
  const y0 = Math.max(0, Math.round(ey - radius)), y1 = Math.min(height - 1, Math.round(ey + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * width + x) * 4;
      const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
      if (r > 190 && b > 190 && g < 100) {
        sx += x; sy += y; n++;
      }
    }
  }
  return n > 20 ? { x: sx / n, y: sy / n, pixels: n } : undefined;
}
