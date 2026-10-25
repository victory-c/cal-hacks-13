import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { FIXTURES_DIR, seedDataDir } from "./seed.ts";
import { FileStore } from "./store.ts";

describe("seed", () => {
  test("copies every fixture once and the store loads all of them cleanly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canon-seed-"));
    try {
      // 10 scaffold facts + 1 session, then the demo world before it starts: 30 facts from 10 items.
      const first = await seedDataDir(dir);
      assert.equal(first.facts, 63);
      assert.equal(first.sessions, 17);
      assert.equal(first.skipped, 0);

      const second = await seedDataDir(dir);
      assert.deepEqual(second, { facts: 0, sessions: 0, skipped: 80 });

      const store = new FileStore(dir);
      const loaded = await store.loadAll();
      assert.deepEqual(loaded, { facts: 63, sessions: 17, skipped: 0 });
      assert.equal(store.listFacts({ tier: "cold" }).length, 1);
      assert.equal(store.listFacts({ folder: "private" }).length, 1);
      assert.equal(store.getFact("fct_a1c3e5f7")?.supersedes, "fct_0b2d4f6e");
      assert.equal((await store.getSession("ses_de0001"))?.client, "claude-code");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the demo world's facts carry the answer key's ids, groups, labels, authors and item sources", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canon-seed-"));
    try {
      await seedDataDir(dir, FIXTURES_DIR, "seed");
      const store = new FileStore(dir);
      await store.loadAll();
      const offer = store.getFact("fct_570001");
      assert.equal(offer?.folder, "deal/stonewall");
      assert.deepEqual(offer?.labels, ["taylor-mason"]);
      assert.equal(offer?.author, "axe");
      const session = await store.getSession(offer?.source.session ?? "");
      assert.equal(session?.meta?.item_id, "itm_sw_terms", "the first item that states the fact is its source");
      assert.equal(session?.principal, "axe");
      assert.equal(store.getFact("fct_57000b"), undefined, "the valuation memo arrives live at 0:25");
      for (const f of store.listFacts({ folder: "deal" })) assert.equal(f.folder, "deal/stonewall");

      await seedDataDir(dir, FIXTURES_DIR, "all");
      await store.loadAll();
      assert.ok(store.getFact("fct_57000b"), "the benchmark's world holds every non-quarantined item");
      assert.equal(store.listFacts().filter((f) => f.id.startsWith("fct_5700")).length, 59, "36 market and deal facts plus 23 everyday ones: invoices, bills and payment rules, trades, payroll");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
