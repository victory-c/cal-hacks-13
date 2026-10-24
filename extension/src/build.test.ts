// Smoke test for scripts/build.mjs. Offline and ~1 s: esbuild bundles into a temp dir. Guards the
// one thing that silently breaks the extension at load time: a Node-only import (node:fs, node:crypto)
// reaching the browser bundle through @canon/shared.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ROUTES } from "@canon/shared";

const script = fileURLToPath(new URL("../scripts/build.mjs", import.meta.url));

test("build.mjs bundles every entry, copies the static files and keeps Node out of the browser", () => {
  const out = mkdtempSync(join(tmpdir(), "canon-extension-"));
  try {
    execFileSync(process.execPath, [script, "--out", out], { stdio: "pipe" });

    for (const f of ["manifest.json", "options.html", "background.js", "options.js", "content/chatgpt.js", "content/claude.js", "content/gemini.js"]) {
      assert.ok(existsSync(join(out, f)), `${f} is in the bundle`);
    }

    const background = readFileSync(join(out, "background.js"), "utf8");
    assert.doesNotMatch(background, /["']node:/, "no node: built-ins in the service worker");
    assert.ok(background.includes(ROUTES.sessions), "the contract constant made it into the bundle");

    const content = readFileSync(join(out, "content/chatgpt.js"), "utf8");
    assert.doesNotMatch(content, /^\s*import\s/m, "content scripts are IIFEs, not modules");
    assert.ok(content.includes("data-message-author-role"));

    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as { manifest_version: number; content_scripts: Array<{ js: string[] }> };
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(
      manifest.content_scripts.flatMap((c) => c.js),
      ["content/chatgpt.js", "content/claude.js", "content/gemini.js"],
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
