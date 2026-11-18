// Bundles the adapter and the hub into dist/ so an installed plugin needs no node_modules.
// (Electron itself is fetched on first use; see src/adapter/hub-client.ts.)
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";

const common = { bundle: true, platform: "node", target: "node20", logLevel: "info", legalComments: "none" };

await build({
  ...common,
  entryPoints: ["src/adapter/server.ts"],
  outfile: "dist/server.js",
  format: "esm",
  // Some bundled dependencies are CommonJS and call require().
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

await build({
  ...common,
  entryPoints: ["src/hub/main.ts"],
  outfile: "dist/hub/main.cjs",
  format: "cjs",
  external: ["electron"],
});

mkdirSync("dist/hub", { recursive: true });
writeFileSync(
  "dist/hub/package.json",
  JSON.stringify({ name: "screen-buddy", productName: "Screen Buddy", main: "main.cjs" }, null, 2) + "\n"
);
