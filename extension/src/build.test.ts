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
import vm from "node:vm";
import { ROUTES } from "@canon/shared";

const script = fileURLToPath(new URL("../scripts/build.mjs", import.meta.url));

test("build.mjs bundles every entry, copies the static files and keeps Node out of the browser", () => {
  const out = mkdtempSync(join(tmpdir(), "canon-extension-"));
  try {
    execFileSync(process.execPath, [script, "--out", out], { stdio: "pipe" });

    for (const f of ["manifest.json", "options.html", "background.js", "options.js", "content/chatgpt.js"]) {
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
      ["content/chatgpt.js"],
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("built content script retries an unchanged snapshot after sendMessage rejects (issue #23)", async () => {
  const out = mkdtempSync(join(tmpdir(), "canon-extension-"));
  try {
    execFileSync(process.execPath, [script, "--out", out], { stdio: "pipe" });
    const code = readFileSync(join(out, "content/chatgpt.js"), "utf8");

    // A minimal page: one stable user turn, manual timers, and a worker that is down at first.
    const timers = new Map<number, () => void>();
    let nextId = 1;
    const setTimer = (fn: () => void) => {
      timers.set(nextId, fn);
      return nextId++;
    };
    let workerUp = false;
    let sends = 0;
    let onMutation: () => void = () => {};
    const turn = { getAttribute: (n: string) => (n === "data-message-author-role" ? "user" : null), innerText: "stable question" };
    const session = new Map<string, string>();
    vm.runInNewContext(code, {
      chrome: {
        runtime: {
          sendMessage: () => {
            sends++;
            return workerUp ? Promise.resolve({ ok: true }) : Promise.reject(new Error("Receiving end does not exist."));
          },
        },
      },
      document: { title: "Stable | ChatGPT", body: {}, querySelectorAll: () => [turn] },
      location: { hostname: "chatgpt.com", pathname: "/c/abc", href: "https://chatgpt.com/c/abc" },
      sessionStorage: { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => session.set(k, v) },
      window: { setTimeout: setTimer, clearTimeout: (id: number) => timers.delete(id), addEventListener: () => {} },
      MutationObserver: class {
        constructor(cb: () => void) {
          onMutation = cb;
        }
        observe() {}
      },
      console: { info() {}, debug() {}, warn() {} },
    });
    const settle = () => new Promise((r) => setImmediate(r));
    const fireAll = async () => {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
      await settle();
    };

    await fireAll(); // the settled capture: rejected
    assert.equal(sends, 1);
    onMutation(); // DOM noise, same transcript; the settle timer and the retry both fire
    await fireAll();
    assert.equal(sends, 2, "the undelivered snapshot is tried again, not suppressed by its fingerprint");
    workerUp = true;
    await fireAll();
    assert.equal(sends, 3, "it lands once the worker is back");
    onMutation();
    await fireAll();
    assert.equal(sends, 3, "after delivery the unchanged transcript is skipped again");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
