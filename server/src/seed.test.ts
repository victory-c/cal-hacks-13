import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { seedDataDir } from "./seed.ts";
import { FileStore } from "./store.ts";

describe("seed", () => {
  test("copies every fixture once and the store loads all of them cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canon-seed-"));
    try {
      const first = await seedDataDir(dir);
      assert.equal(first.facts, 23);
      assert.equal(first.sessions, 1);
      assert.equal(first.skipped, 0);

      const second = await seedDataDir(dir);
      assert.deepEqual(second, { facts: 0, sessions: 0, skipped: 24 });

      const store = new FileStore(dir);
      const loaded = await store.loadAll();
      assert.deepEqual(loaded, { facts: 23, sessions: 1, skipped: 0 });
      assert.equal(store.listFacts({ tier: "cold" }).length, 1);
      assert.equal(store.listFacts({ folder: "private" }).length, 1);
      assert.equal(store.getFact("fct_a1c3e5f7")?.supersedes, "fct_0b2d4f6e");
      assert.equal((await store.getSession("ses_de0001"))?.client, "claude-code");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
