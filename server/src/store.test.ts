import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import type { CapturedSession, Fact } from "@canon/shared";

import { FileStore, SessionOwnerError, writeAtomic } from "./store.ts";

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

  test("putSession applies the caller's ownership rule to the stored session, even for a store that has not loaded the archive", async (t) => {
    const own = await mkdtemp(join(tmpdir(), "canon-store-owner-"));
    t.after(() => rm(own, { recursive: true, force: true }));
    const store = new FileStore(own);
    const session: CapturedSession = {
      id: "ses_00cd",
      client: "claude-code",
      started_at: "2026-10-24T03:12:00.000Z",
      messages: [{ role: "user", content: "original" }],
    };
    const sameClient = (incoming: CapturedSession) => (existing: CapturedSession) => existing.client === incoming.client;
    assert.deepEqual(await store.putSession(session, sameClient(session)), { updated: false });
    const intruder = { ...session, client: "chatgpt", messages: [{ role: "user" as const, content: "replacement" }] };
    await assert.rejects(store.putSession(intruder, sameClient(intruder)), (err: unknown) => err instanceof SessionOwnerError && err.sessionId === "ses_00cd");
    await assert.rejects(new FileStore(own).putSession(intruder, sameClient(intruder)), SessionOwnerError);
    assert.deepEqual(await store.getSession("ses_00cd"), session);
    assert.equal(store.sessionClient("ses_00cd"), "claude-code");
    const update = { ...session, ended_at: "2026-10-24T03:20:00.000Z" };
    assert.deepEqual(await new FileStore(own).putSession(update, sameClient(update)), { updated: true });
  });

  test("queued session writes recheck Stop immediately before writing", async (t) => {
    const own = await mkdtemp(join(tmpdir(), "canon-stop-queue-"));
    t.after(() => rm(own, { recursive: true, force: true }));
    const store = new FileStore(own);
    const session: CapturedSession = { id: "ses_00ef", client: "dispatcher", started_at: "now", messages: [] };
    const read = store.getSession.bind(store);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    t.mock.method(store, "getSession", async (id: string) => {
      if (first) { first = false; entered(); await gate; }
      return read(id);
    });
    const initial = store.putSession(session, () => true);
    await started;
    let stopped = false;
    const queued = store.putSession({ ...session, title: "Late output" }, () => true, () => {
      if (stopped) throw new Error("agent run was stopped");
    });
    const rejected = assert.rejects(queued, /agent run was stopped/);
    stopped = true;
    release();
    await initial;
    await rejected;
    assert.deepEqual(await read(session.id), session);
  });

  test("concurrent first writes of one id with an ownership rule: exactly one wins and owns it", async (t) => {
    const own = await mkdtemp(join(tmpdir(), "canon-store-race-"));
    t.after(() => rm(own, { recursive: true, force: true }));
    const store = new FileStore(own);
    const mk = (client: string, principal: string): CapturedSession => ({
      id: "ses_00ce",
      client,
      principal,
      started_at: "2026-10-24T03:12:00.000Z",
      messages: [{ role: "user", content: `from ${client}` }],
    });
    const put = (s: CapturedSession) => store.putSession(s, (existing) => existing.client === s.client && existing.principal === s.principal);
    const results = await Promise.allSettled([put(mk("claude-code", "dan")), put(mk("chatgpt", "priya"))]);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected"]);
    assert.ok(results[1].status === "rejected" && results[1].reason instanceof SessionOwnerError);
    assert.deepEqual(await store.getSession("ses_00ce"), mk("claude-code", "dan"));
    assert.equal(store.sessionClient("ses_00ce"), "claude-code");
    assert.equal(store.sessionPrincipal("ses_00ce"), "dan");
  });

  test("rejects a session id that is not ses_<hex>, so no path traversal", async () => {
    const store = new FileStore(dir);
    await assert.rejects(store.getSession("../../etc/passwd"), /session id must match/);
    await assert.rejects(
      store.putSession({ id: "ses_../x", client: "c", started_at: "now", messages: [] }),
      /session id must match/,
    );
  });

  test("loadAll sweeps tmp files orphaned by a crash mid-write and never counts them", async () => {
    const orphanFact = join(dir, "facts", "career", "projects", "fct_0001aaaa.md.1a2b3c4d.tmp");
    const orphanSession = join(dir, "sessions", "ses_00ab.json.5e6f7a8b.tmp");
    await writeFile(orphanFact, "half-written");
    await writeFile(orphanSession, "{");
    const original = console.warn;
    console.warn = () => {};
    try {
      const store = new FileStore(dir);
      const loaded = await store.loadAll();
      assert.equal(loaded.skipped, 0, "a tmp file is swept, not counted as a skipped file");
      assert.deepEqual(store.getFact(base.id), base, "the intact real file still loads");
    } finally {
      console.warn = original;
    }
    assert.ok(!(await exists(orphanFact)));
    assert.ok(!(await exists(orphanSession)));
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

describe("writeAtomic on a busy target (Windows: OneDrive, antivirus, the indexer)", () => {
  const busy = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

  test("a rename refused while another process holds the file is retried until it lands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canon-atomic-"));
    try {
      const file = join(dir, "scopes.json");
      let calls = 0;
      await writeAtomic(file, "new\n", {
        rename: async (from, to) => {
          calls++;
          if (calls <= 3) throw busy(["EPERM", "EACCES", "EBUSY"][calls - 1]);
          await rename(from, to);
        },
      });
      assert.equal(calls, 4, "three refusals, then the rename that lands");
      assert.equal(await readFile(file, "utf8"), "new\n");
      assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith(".tmp")), [], "no tmp left behind");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a target that stays busy, or any other error, rejects and removes the tmp", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canon-atomic-"));
    try {
      const file = join(dir, "scopes.json");
      await writeFile(file, "old\n");
      let calls = 0;
      await assert.rejects(writeAtomic(file, "new\n", { rename: async () => { calls++; throw busy("EPERM"); } }), /EPERM/);
      assert.ok(calls > 1 && calls < 20, `bounded retries (${calls})`);
      calls = 0;
      await assert.rejects(writeAtomic(file, "new\n", { rename: async () => { calls++; throw busy("ENOSPC"); } }), /ENOSPC/);
      assert.equal(calls, 1, "only a busy target is retried");
      assert.equal(await readFile(file, "utf8"), "old\n", "the real file is untouched");
      assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith(".tmp")), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
