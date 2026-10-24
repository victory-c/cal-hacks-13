import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { DEMO_GRANTS } from "@canon/shared";

import { DEV_CLIENT_TOKENS, authenticate, loadGrants, loadTokens } from "./auth.ts";

const tokens = new Map([
  ["tok-cc", "claude-code"],
  ["tok-gpt", "chatgpt"],
]);

const req = (authorization?: string) => ({ headers: authorization === undefined ? {} : { authorization } }) as IncomingMessage;

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]] as const));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("authenticate", () => {
  test("maps a known bearer token to its client", () => {
    assert.deepEqual(authenticate(req("Bearer tok-cc"), tokens), { client: "claude-code" });
    assert.deepEqual(authenticate(req("bearer tok-gpt"), tokens), { client: "chatgpt" });
  });

  test("returns null for a missing, malformed or unknown token", () => {
    assert.equal(authenticate(req(), tokens), null);
    assert.equal(authenticate(req("tok-cc"), tokens), null);
    assert.equal(authenticate(req("Basic tok-cc"), tokens), null);
    assert.equal(authenticate(req("Bearer nope"), tokens), null);
    assert.equal(authenticate(req("Bearer "), tokens), null);
  });
});

describe("loadTokens", () => {
  test("reads CANON_CLIENT_TOKENS", async () => {
    await withEnv({ CANON_CLIENT_TOKENS: "claude-code=abc, chatgpt=def" }, () => {
      const map = loadTokens();
      assert.equal(map.get("abc"), "claude-code");
      assert.equal(map.get("def"), "chatgpt");
    });
  });

  test("falls back to the dev tokens from .env.example with a warning", async () => {
    await withEnv({ CANON_CLIENT_TOKENS: undefined }, () => {
      const original = console.warn;
      let warned = "";
      console.warn = (...a: unknown[]) => (warned += a.join(" "));
      try {
        const map = loadTokens();
        assert.equal(map.get("dev-claude-code"), "claude-code");
        assert.ok(DEV_CLIENT_TOKENS.includes("distiller=dev-distiller"));
      } finally {
        console.warn = original;
      }
      assert.match(warned, /dev tokens/);
    });
  });

  test("refuses a value with no client=token pair", async () => {
    await withEnv({ CANON_CLIENT_TOKENS: "garbage" }, () => assert.throws(() => loadTokens(), /no "client=token" pairs/));
  });
});

describe("loadGrants", () => {
  test("defaults to a copy of DEMO_GRANTS", async () => {
    await withEnv({ CANON_GRANTS_FILE: undefined }, () => {
      const grants = loadGrants();
      assert.deepEqual(grants, DEMO_GRANTS);
      assert.notEqual(grants[0], DEMO_GRANTS[0]); // a copy, so callers cannot mutate the constant
    });
  });

  test("reads and validates CANON_GRANTS_FILE", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canon-grants-"));
    try {
      const good = join(dir, "grants.json");
      await writeFile(good, JSON.stringify([{ client: "hermes", read: ["projects"], write: [] }]));
      await withEnv({ CANON_GRANTS_FILE: good }, () => assert.deepEqual(loadGrants(), [{ client: "hermes", read: ["projects"], write: [] }]));

      const bad = join(dir, "bad.json");
      await writeFile(bad, JSON.stringify([{ client: "hermes", read: "projects" }]));
      await withEnv({ CANON_GRANTS_FILE: bad }, () => assert.throws(() => loadGrants(), /entry 0 must be/));
      await withEnv({ CANON_GRANTS_FILE: join(dir, "missing.json") }, () => assert.throws(() => loadGrants(), /ENOENT/));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
