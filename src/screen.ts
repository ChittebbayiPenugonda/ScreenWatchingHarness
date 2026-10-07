import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);

export type Capture = { base64: string; width: number; height: number };

// Captures the main display, downscaled so the image is cheap to send.
export async function captureScreen(maxDim = 1280, quality = 60): Promise<Capture> {
  const raw = join(tmpdir(), `swh-${process.pid}-raw.jpg`);
  const out = join(tmpdir(), `swh-${process.pid}-out.jpg`);
  try {
    await run("screencapture", ["-x", "-m", "-t", "jpg", raw]);
    await run("sips", ["-Z", String(maxDim), "-s", "formatOptions", String(quality), raw, "--out", out]);
    const { stdout } = await run("sips", ["-g", "pixelWidth", "-g", "pixelHeight", out]);
    const width = Number(/pixelWidth: (\d+)/.exec(stdout)?.[1]);
    const height = Number(/pixelHeight: (\d+)/.exec(stdout)?.[1]);
    const base64 = (await readFile(out)).toString("base64");
    return { base64, width, height };
  } finally {
    await rm(raw, { force: true });
    await rm(out, { force: true });
  }
}
