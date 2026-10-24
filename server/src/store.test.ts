import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import type { CapturedSession, Fact } from "@canon/shared";

import { FileStore } from "./store.ts";

const base: Fact = {
  id: "fct_0001aaaa",
  statement: "Built Canon's live capture hook for Claude Code sessions",
  folder: "career/projects",
  tier: "hot",
  jev_keep: 0.91,
  source: { client: "claude-code", session: "ses_0001" },
  updated: "2026-10-24",
  detail: "Some detail.",
};

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

describe("FileStore", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "canon-store-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("putFact writes facts/<folder>/<id>.md and a fresh store reads it back", async () => {
    const store = new FileStore(dir);
    await store.putFact(base);
    const file = join(dir, "facts", "career", "projects", "fct_0001aaaa.md");
    assert.ok(await exists(file));
    assert.match(await readFile(file, "utf8"), /^---\nid: fct_0001aaaa\n/);

    const again = new FileStore(dir);
    const loaded = await again.loadAll();
    assert.equal(loaded.facts, 1);
    assert.equal(loaded.skipped, 0);
    assert.deepEqual(again.getFact(base.id), base);
  });

  test("putFact refuses an invalid fact before touching the disk", async () => {
    const store = new FileStore(dir);
    await assert.rejects(store.putFact({ ...base, id: "nope" }), /putFact: id must match/);
  });

  test("listFacts filters by folder prefix (per segment) and by tier", async () => {
    const store = new FileStore(dir);
    await store.loadAll();
    await store.putFact({ ...base, id: "fct_0002bbbb", folder: "career/skills", tier: "cold", updated: "2026-10-01" });
    await store.putFact({ ...base, id: "fct_0003cccc", folder: "private/health", updated: "2026-10-02" });
    await store.putFact({ ...base, id: "fct_0004dddd", folder: "career", updated: "2026-10-03" });

    const ids = (fs: Fact[]) => fs.map((f) => f.id).sort();
    assert.deepEqual(ids(store.listFacts({ folder: "career" })), ["fct_0001aaaa", "fct_0002bbbb", "fct_0004dddd"]);
    assert.deepEqual(ids(store.listFacts({ folder: "career/skills" })), ["fct_0002bbbb"]);
    assert.deepEqual(ids(store.listFacts({ tier: "cold" })), ["fct_0002bbbb"]);
    assert.deepEqual(ids(store.listFacts({ folder: "career", tier: "hot" })), ["fct_0001aaaa", "fct_0004dddd"]);
    // Newest first.
    assert.equal(store.listFacts()[0].id, "fct_0001aaaa");
    assert.equal(store.counts().facts, 4);
  });

  test("moving a fact to another folder removes the old file", async () => {
    const store = new FileStore(dir);
    await store.loadAll();
    const moved = { ...base, id: "fct_0003cccc", folder: "career/health" as const };
    await store.putFact(moved);
    assert.ok(!(await exists(join(dir, "facts", "private", "health", "fct_0003cccc.md"))));
    assert.ok(await exists(join(dir, "facts", "career", "health", "fct_0003cccc.md")));
    assert.equal(store.getFact("fct_0003cccc")?.folder, "career/health");
  });

  test("putSession upserts and getSession round-trips", async () => {
    const store = new FileStore(dir);
    const session: CapturedSession = {
      id: "ses_00ab",
      client: "claude-code",
      started_at: "2026-10-24T03:12:00.000Z",
      messages: [{ role: "user", content: "hi" }],
    };
    assert.deepEqual(await store.putSession(session), { updated: false });
    assert.deepEqual(await store.putSession({ ...session, ended_at: "2026-10-24T03:20:00.000Z" }), { updated: true });
    const back = await store.getSession("ses_00ab");
    assert.equal(back?.ended_at, "2026-10-24T03:20:00.000Z");
    assert.equal(await store.getSession("ses_ffff"), undefined);
    assert.equal(store.counts().sessions, 1);
  });

  test("rejects a session id that is not ses_<hex>, so no path traversal", async () => {
    const store = new FileStore(dir);
    await assert.rejects(store.getSession("../../etc/passwd"), /session id must match/);
    await assert.rejects(
      store.putSession({ id: "ses_../x", client: "c", started_at: "now", messages: [] }),
      /session id must match/,
    );
  });

  test("loadAll skips an unparsable fact file and a mismatched session with warnings", async () => {
    await mkdir(join(dir, "facts", "inbox"), { recursive: true });
    await writeFile(join(dir, "facts", "inbox", "broken.md"), "not a fact\n");
    await writeFile(join(dir, "sessions", "ses_bad0.json"), JSON.stringify({ id: "ses_other" }));
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      const store = new FileStore(dir);
      const loaded = await store.loadAll();
      assert.equal(loaded.skipped, 2);
      assert.equal(loaded.facts, 4);
      assert.equal(loaded.sessions, 1);
    } finally {
      console.warn = original;
    }
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /broken\.md/);
    assert.match(warnings[1], /does not match the file name/);
  });
});
