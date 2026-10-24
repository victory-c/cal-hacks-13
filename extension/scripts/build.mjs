#!/usr/bin/env node
// Bundles the extension into dist/ with esbuild (a root devDependency). Tests need no build (tsx
// runs the TypeScript directly); Chrome does, because it only loads plain JS.
//
//   node scripts/build.mjs            one build
//   node scripts/build.mjs --watch    rebuild on every change (reload the extension in Chrome after)
//   node scripts/build.mjs --out DIR  build somewhere else (the build test uses a temp dir)

import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url)); // extension/
const args = process.argv.slice(2);
const watch = args.includes("--watch");
const outFlag = args.indexOf("--out");
const outdir = outFlag >= 0 && args[outFlag + 1] ? resolve(args[outFlag + 1]) : join(root, "dist");

// @canon/shared's index also re-exports Node-only helpers (env.ts reads .env with node:fs, ids.ts
// uses node:crypto, the judges call fetch with API keys). None of that can run in a browser, so
// inside the extension the package resolves to the frozen contract only: every file under
// shared/src/types/ (types + constants such as ROUTES and DEFAULT_SERVER_URL). Importing a runtime
// helper from "@canon/shared" in extension code therefore fails this build with "No matching
// export", which is the right answer: port the helper into src/shared/ or keep it in Node.
const sharedIndex = fileURLToPath(import.meta.resolve("@canon/shared"));
const typesDir = join(dirname(sharedIndex), "types");
const contractOnly = {
  name: "canon-shared-contract-only",
  setup(build) {
    build.onResolve({ filter: /^@canon\/shared$/ }, () => ({ path: "contract", namespace: "canon-shared" }));
    build.onLoad({ filter: /.*/, namespace: "canon-shared" }, () => ({
      contents: readdirSync(typesDir)
        .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => `export * from ${JSON.stringify(join(typesDir, f))};`)
        .join("\n"),
      loader: "ts",
      resolveDir: typesDir,
    }));
  },
};

// manifest.json and options.html are not bundled; copy them after every (re)build.
const copyStatic = {
  name: "copy-static",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      mkdirSync(outdir, { recursive: true });
      cpSync(join(root, "manifest.json"), join(outdir, "manifest.json"));
      cpSync(join(root, "src/options.html"), join(outdir, "options.html"));
    });
  },
};

const common = {
  bundle: true,
  platform: "browser",
  target: "chrome120",
  sourcemap: true,
  outdir,
  outbase: join(root, "src"), // src/content/chatgpt.ts → dist/content/chatgpt.js
  logLevel: "info",
};

const builds = [
  // Service worker + options page are real ES modules (manifest: background.type = "module").
  {
    ...common,
    format: "esm",
    entryPoints: [join(root, "src/background.ts"), join(root, "src/options.ts")],
    plugins: [contractOnly, copyStatic],
  },
  // Content scripts are injected as classic scripts, so each one must be a self-contained IIFE.
  {
    ...common,
    format: "iife",
    entryPoints: ["chatgpt", "claude", "gemini"].map((site) => join(root, `src/content/${site}.ts`)),
    plugins: [contractOnly],
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log(`Watching ${join(root, "src")} → ${outdir}`);
  console.log("Load unpacked: chrome://extensions → extension/dist  (click the extension's reload icon after each rebuild)");
  process.on("SIGINT", async () => {
    await Promise.all(contexts.map((c) => c.dispose()));
    process.exit(0);
  });
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  console.log(`Built → ${outdir}`);
  console.log("Load unpacked: chrome://extensions → extension/dist");
}
