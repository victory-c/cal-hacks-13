#!/usr/bin/env node
// Bundles the dashboard with esbuild (a root devDependency; the page itself has no dependencies):
// src/main.ts + src/resume.ts → dist/*.js (esm, es2022, sourcemaps), plus a copy of src/*.html
// and src/styles.css.
//   node scripts/build.mjs                  build once
//   node scripts/build.mjs --watch          rebuild and recopy on change
//   node scripts/build.mjs --watch --serve  also run scripts/serve.mjs (npm run dev -w web)

import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(webDir, "src");
const distDir = join(webDir, "dist");
const args = new Set(process.argv.slice(2));

/**
 * @canon/shared's index also re-exports Node-only helpers (env.ts → node:fs/path/url, ids.ts →
 * node:crypto). The browser never calls them, but esbuild must still resolve those imports. This
 * plugin answers each `node:*` import with a stub exporting exactly the names the importing file
 * asked for, as no-op functions, so the bundle builds and the one top-level call in shared
 * (REPO_ROOT in env.ts) does not throw on load. A new node import in shared needs no change here.
 */
const nodeStubs = {
  name: "node-builtins-stub",
  setup(build) {
    build.onResolve({ filter: /^node:/ }, (args) => ({
      path: `${args.path}?from=${args.importer}`,
      namespace: "node-stub",
      pluginData: importedNames(readFileSync(args.importer, "utf8"), args.path),
    }));
    build.onLoad({ filter: /.*/, namespace: "node-stub" }, (args) => ({
      loader: "js",
      contents: ["const noop = () => undefined;", ...args.pluginData.map((n) => `export const ${n} = noop;`), "export default {};"].join("\n"),
    }));
  },
};

/** The names in every `import { a, b as c } from "<specifier>"` of `source`. */
function importedNames(source, specifier) {
  const names = new Set();
  const re = new RegExp(String.raw`import\s+(?:type\s+)?(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*["']${specifier}["']`, "g");
  for (const m of source.matchAll(re)) {
    for (const part of m[1].split(",")) {
      const name = part.replace(/^\s*type\s+/, "").trim().split(/\s+as\s+/)[0];
      if (name) names.add(name);
    }
  }
  return [...names];
}

const options = {
  entryPoints: [join(srcDir, "main.ts"), join(srcDir, "resume.ts")],
  outdir: distDir,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  logLevel: "info",
  plugins: [nodeStubs],
};

const isStatic = (f) => f.endsWith(".html") || f.endsWith(".css");

function copyStatic() {
  mkdirSync(distDir, { recursive: true });
  for (const f of readdirSync(srcDir)) if (isStatic(f)) copyFileSync(join(srcDir, f), join(distDir, f));
}

if (args.has("--watch")) {
  copyStatic();
  const ctx = await esbuild.context(options);
  await ctx.watch();
  watch(srcDir, (_, file) => {
    if (file && isStatic(file)) {
      copyStatic();
      console.log(`[web] copied ${file}`);
    }
  });
  console.log(`[web] watching ${srcDir} → ${distDir}`);

  if (args.has("--serve")) {
    // serve.mjs imports @canon/shared (TypeScript) for loadEnv(), hence tsx.
    const child = spawn(process.execPath, ["--import", "tsx", join(webDir, "scripts", "serve.mjs")], { stdio: "inherit", cwd: webDir, env: process.env });
    child.on("exit", (code) => {
      console.error(`[web] serve exited (${code ?? "signal"})`);
      process.exit(code ?? 1);
    });
    const stop = () => {
      child.kill("SIGINT");
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }
} else {
  copyStatic();
  await esbuild.build(options);
  console.log(`[web] built → ${distDir}`);
}
