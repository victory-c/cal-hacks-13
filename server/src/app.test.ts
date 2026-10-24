// End to end over real HTTP on port 0: REST, SSE and the MCP endpoint through the SDK client.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { DEMO_GRANTS, FakeJudge, parseSseChunk } from "@canon/shared";
import type { CanonEvent, CapturedSession, Fact, HealthResponse, SaveDecision } from "@canon/shared";

import { startServer } from "./app.ts";
import type { RunningServer } from "./app.ts";
import { KeywordRetriever } from "./retrieval/keyword.ts";

const tokens = new Map([
  ["tok-cc", "claude-code"],
  ["tok-gpt", "chatgpt"],
  ["tok-dist", "distiller"],
  ["tok-maya", "maya"], // the moderator's own client (DEMO_GRANTS binds it to principal maya)
  ["tok-dan", "dan"], // a member's per-person client
]);

const session: CapturedSession = {
  id: "ses_e2e00001",
  client: "claude-code",
  started_at: "2026-10-24T03:12:00.000Z",
  title: "Wire the hook",
  messages: [
    { role: "user", content: "Add the Claude Code capture hook" },
    { role: "assistant", content: "Done: hooks/capture.mjs posts CapturedSession to /api/sessions" },
  ],
  meta: { cwd: "~/cal-hacks-13" },
};

const factA: Fact = {
  id: "fct_e2e0000a",
  statement: "Learning TypeScript; most work still in Python",
  folder: "career/skills",
  tier: "hot",
  jev_keep: 0.65,
  source: { client: "chatgpt", session: "ses_e2e00002" },
  updated: "2026-09-01",
};
const factB: Fact = {
  ...factA,
  id: "fct_e2e0000b",
  statement: "Writes production TypeScript on Node 22 every day",
  jev_keep: 0.9,
  supersedes: factA.id,
  updated: "2026-10-24",
};
const factPrivate: Fact = {
  ...factA,
  id: "fct_e2e0000d",
  statement: "Sleeps 06:00–10:00 during the hackathon",
  folder: "private/health",
  source: { client: "claude-web", session: "ses_e2e00003" },
  updated: "2026-10-22",
};
const decision = (action: SaveDecision["action"], supersedes?: string, folder: Fact["folder"] = "career/skills"): SaveDecision => ({
  tier: "hot",
  folder,
  action,
  ...(supersedes ? { supersedes } : {}),
  keep_p: 0.9,
  folder_p: 0.8,
  judge: "fake",
});

type ToolResult = { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

describe("server over HTTP", () => {
  let dir: string;
  let running: RunningServer;
  let events: CanonEvent[];
  const originalInfo = console.info;

  const api = (path: string, init: RequestInit & { token?: string; json?: unknown } = {}) => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.json !== undefined) headers["content-type"] = "application/json";
    return fetch(`${running.url}${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  };

  before(async () => {
    console.info = () => {};
    dir = await mkdtemp(join(tmpdir(), "canon-app-"));
    running = await startServer({ port: 0, dataDir: dir, tokens, grants: [...DEMO_GRANTS], judge: new FakeJudge(), retriever: new KeywordRetriever(), log: () => {} });
    events = [];
    running.bus.subscribe((e) => events.push(e));
  });
  after(async () => {
    await running.close();
    await rm(dir, { recursive: true, force: true });
    console.info = originalInfo;
  });

  test("GET /health", async () => {
    const res = await api("/health");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const body = (await res.json()) as HealthResponse;
    assert.equal(body.ok, true);
    assert.equal(body.judge, "fake");
    assert.equal(body.retriever, "keyword");
    assert.deepEqual([body.facts, body.sessions], [0, 0]);
  });

  test("unknown routes and preflight", async () => {
    assert.equal((await api("/nope")).status, 404);
    const pre = await api("/api/sessions", { method: "OPTIONS" });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get("access-control-allow-headers") ?? "", /Authorization/);
  });

  test("POST /api/sessions: 401 without a token, 200 with one, 403 when the body names another client", async () => {
    assert.equal((await api("/api/sessions", { method: "POST", json: session })).status, 401);
    assert.equal((await api("/api/sessions", { method: "POST", json: session, token: "wrong" })).status, 401);

    const ok = await api("/api/sessions", { method: "POST", json: session, token: "tok-cc" });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { id: session.id, updated: false });

    const again = await api("/api/sessions", { method: "POST", json: { ...session, ended_at: "2026-10-24T03:30:00.000Z" }, token: "tok-cc" });
    assert.deepEqual(await again.json(), { id: session.id, updated: true });

    const mismatch = await api("/api/sessions", { method: "POST", json: { ...session, client: "chatgpt" }, token: "tok-cc" });
    assert.equal(mismatch.status, 403);
    assert.match(((await mismatch.json()) as { error: string }).error, /token belongs to "claude-code"/);

    const bad = await api("/api/sessions", { method: "POST", json: { ...session, messages: [{ role: "robot", content: "x" }] }, token: "tok-cc" });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /messages\[0\]\.role/);

    const captured = events.filter((e) => e.type === "session.captured");
    assert.equal(captured.length, 2);
    assert.deepEqual(captured.map((e) => (e.type === "session.captured" ? e.session.ended : null)), [false, true]);
  });

  test("GET /api/sessions/:id: moderators and internal clients only — a raw session holds more than any one scope", async () => {
    assert.equal((await api(`/api/sessions/${session.id}`)).status, 401);
    const res = await api(`/api/sessions/${session.id}`, { token: "tok-maya" });
    assert.equal(res.status, 200, "the moderator's client reads the archive");
    const body = (await res.json()) as CapturedSession;
    assert.equal(body.ended_at, "2026-10-24T03:30:00.000Z");
    assert.equal(body.messages.length, 2);
    assert.equal((await api(`/api/sessions/${session.id}`, { token: "tok-dist" })).status, 200, "internal worker");

    // Even the capturing client is denied, with the same bytes whether the session exists or not:
    // the 403 is decided before the id is parsed, so nothing is named, counted or hinted at.
    const deny = async (id: string, token: string) => {
      const r = await api(`/api/sessions/${id}`, { token });
      assert.equal(r.status, 403, `${token} on ${id}`);
      assert.deepEqual(await r.json(), { error: "moderators only" });
    };
    await deny(session.id, "tok-cc");
    await deny(session.id, "tok-gpt");
    await deny("ses_ffffffff", "tok-gpt");
    await deny("..%2F..%2Fetc", "tok-gpt");

    assert.equal((await api("/api/sessions/ses_ffffffff", { token: "tok-maya" })).status, 404, "a moderator may learn a session is missing");
    assert.equal((await api("/api/sessions/..%2F..%2Fetc", { token: "tok-maya" })).status, 400);
  });

  test("POST /api/sessions: a per-person client is bound to its own principal; operators may set one", async () => {
    const mine: CapturedSession = {
      id: "ses_e2e000da",
      client: "dan",
      started_at: "2026-10-24T09:00:00.000Z",
      messages: [{ role: "user", content: "Falcon diligence notes from this morning's call" }],
      kind: "note",
    };
    const mismatch = await api("/api/sessions", { method: "POST", json: { ...mine, principal: "leo" }, token: "tok-dan" });
    assert.equal(mismatch.status, 403, "naming someone else's principal is rejected");
    assert.match(((await mismatch.json()) as { error: string }).error, /captures for "dan"/);

    assert.equal((await api("/api/sessions", { method: "POST", json: mine, token: "tok-dan" })).status, 200);
    const stored = (await (await api(`/api/sessions/${mine.id}`, { token: "tok-maya" })).json()) as CapturedSession;
    assert.equal(stored.principal, "dan", "a missing principal is filled in from the client's grant");
    assert.equal(stored.kind, "note", "kind survives the round trip");

    // An operator client (the hook's CANON_PRINCIPAL, the ingest CLI's author) names the principal itself.
    const memo: CapturedSession = { ...session, id: "ses_e2e000db", principal: "dan", kind: "memo", external: true };
    assert.equal((await api("/api/sessions", { method: "POST", json: memo, token: "tok-cc" })).status, 200);
    const storedMemo = (await (await api(`/api/sessions/${memo.id}`, { token: "tok-dist" })).json()) as CapturedSession;
    assert.equal(storedMemo.principal, "dan");
    assert.equal(storedMemo.kind, "memo");
    assert.equal(storedMemo.external, true);

    for (const bad of [{ kind: "tweet" }, { principal: "" }, { external: "yes" }]) {
      assert.equal((await api("/api/sessions", { method: "POST", json: { ...memo, ...bad }, token: "tok-cc" })).status, 400, JSON.stringify(bad));
    }
  });

  test("a request target Node accepts but the URL parser rejects is a 400, not a crash", async () => {
    const { port } = new URL(running.url);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), "127.0.0.1", () => {
        socket.write("GET http://x:99999/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      });
      let data = "";
      socket.on("data", (chunk) => (data += chunk));
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    assert.match(reply, /^HTTP\/1\.1 400 /);
    assert.match(reply, /bad request URL/);
    assert.equal((await api("/health")).status, 200, "the server is still up");
  });

  test("POST /api/facts: supersede retires the old fact to cold and emits fact.retired", async () => {
    const first = await api("/api/facts", { method: "POST", token: "tok-dist", json: { facts: [{ fact: factA, decision: decision("add") }] } });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { saved: [factA.id], retired: [] });

    const second = await api("/api/facts", { method: "POST", token: "tok-dist", json: { facts: [{ fact: factB, decision: decision("supersede", factA.id) }] } });
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { saved: [factB.id], retired: [factA.id] });

    assert.equal(running.store.getFact(factA.id)?.tier, "cold");
    assert.equal(running.store.getFact(factB.id)?.tier, "hot");
    const retired = events.find((e) => e.type === "fact.retired");
    assert.ok(retired && retired.type === "fact.retired");
    assert.deepEqual([retired.id, retired.superseded_by], [factA.id, factB.id]);
    assert.equal(events.filter((e) => e.type === "fact.saved").length, 2);

    const invalid = await api("/api/facts", { method: "POST", token: "tok-dist", json: { facts: [{ fact: { ...factA, tier: "warm" }, decision: decision("add") }] } });
    assert.equal(invalid.status, 400);
    assert.match(((await invalid.json()) as { error: string }).error, /facts\[0\]\.fact: tier must be/);
  });

  test("POST /api/facts: the decision is validated, not trusted", async () => {
    // A statement no other test searches for, so the fact this leaves behind trips nothing later.
    const factE: Fact = { ...factA, id: "fct_e2e0000e", statement: "Prefers zsh over bash for shell work" };
    const post = (d: unknown) => api("/api/facts", { method: "POST", token: "tok-dist", json: { facts: [{ fact: factE, decision: d }] } });
    const expect400 = async (d: unknown, re: RegExp) => {
      const res = await post(d);
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { error: string }).error, re);
    };
    await expect400({ ...decision("add"), action: "superseded" }, /decision\.action must be add\|merge\|supersede/);
    await expect400(decision("supersede"), /decision\.supersedes is required/);
    await expect400(decision("supersede", "not-an-id"), /decision\.supersedes must match/);
    await expect400({ ...decision("add"), tier: "cold" }, /decision\.tier must equal fact\.tier/);
    await expect400({ ...decision("add"), folder: "career" }, /decision\.folder must equal fact\.folder/);
    await expect400({ ...decision("add"), keep_p: 1.5 }, /decision\.keep_p must be a number in \[0, 1\]/);
    await expect400({ ...decision("add"), judge: "oracle" }, /decision\.judge must be/);
    await expect400("add", /decision must be a SaveDecision object/);
    assert.equal(running.store.getFact("fct_e2e0000e"), undefined, "nothing was written");

    // Extra fields are dropped before the decision is broadcast.
    const before = events.length;
    const ok = await post({ ...decision("add"), verbose: "payload", nested: { x: 1 } });
    assert.equal(ok.status, 200);
    const saved = events.slice(before).find((e) => e.type === "fact.saved");
    assert.ok(saved && saved.type === "fact.saved");
    assert.deepEqual(saved.decision, decision("add"));
  });

  test("POST /api/facts: a client without write access gets 403 and access.denied", async () => {
    const res = await api("/api/facts", { method: "POST", token: "tok-gpt", json: { facts: [{ fact: { ...factA, id: "fct_e2e0000c" }, decision: decision("add") }] } });
    assert.equal(res.status, 403);
    const denied = events.find((e) => e.type === "access.denied" && e.tool === "POST /api/facts");
    assert.ok(denied && denied.type === "access.denied");
    assert.equal(denied.client, "chatgpt");
    assert.equal(running.store.getFact("fct_e2e0000c"), undefined);
  });

  test("GET /api/facts filters by folder and tier without a token, and never shows private/ to a tokenless caller", async () => {
    const priv = await api("/api/facts", { method: "POST", token: "tok-dist", json: { facts: [{ fact: factPrivate, decision: decision("add", undefined, factPrivate.folder) }] } });
    assert.equal(priv.status, 200);

    const ids = async (path: string, token?: string) => ((await (await api(path, { token })).json()) as { facts: Fact[] }).facts.map((f) => f.id).sort();
    assert.deepEqual(await ids("/api/facts"), [factA.id, factB.id, "fct_e2e0000e"], "the dashboard view has no private/ fact");
    assert.deepEqual(await ids("/api/facts?tier=cold"), [factA.id]);
    assert.deepEqual(await ids("/api/facts?folder=career&tier=hot"), [factB.id, "fct_e2e0000e"]);
    assert.deepEqual(await ids("/api/facts?folder=private"), [], "asking for private/ without a token yields nothing");
    assert.equal((await api("/api/facts?tier=warm")).status, 400);

    // A token narrows the list to that client's read grant; the distiller reads every folder.
    assert.deepEqual(await ids("/api/facts", "tok-dist"), [factA.id, factB.id, factPrivate.id, "fct_e2e0000e"]);
    assert.deepEqual(await ids("/api/facts", "tok-gpt"), [factA.id, factB.id, "fct_e2e0000e"], "chatgpt reads career/ only");
    assert.equal((await api("/api/facts", { token: "wrong" })).status, 401, "an unknown token is not downgraded to the public view");

    const grants = (await (await api("/api/grants")).json()) as { grants: unknown[] };
    assert.equal(grants.grants.length, DEMO_GRANTS.length);
  });

  /**
   * Opens /events and reads the replay. The replay is written before the response headers go out,
   * so a marker emitted after the fetch resolves is the first live event: reading until it shows
   * up collects the whole replay without guessing how many frames the subscriber's view has.
   */
  async function readReplay(token?: string): Promise<Array<{ event?: string; data: string }>> {
    const controller = new AbortController();
    const headers: Record<string, string> = { accept: "text/event-stream" };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${running.url}/events`, { signal: controller.signal, headers });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const marker = running.bus.emit({ type: "server.started", facts: Math.floor(Math.random() * 1e9), sessions: 0 });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let parsed: Array<{ event?: string; data: string }> = [];
    const seenMarker = () => parsed.some((e) => e.event === "server.started" && (JSON.parse(e.data) as { facts: number }).facts === (marker as { facts: number }).facts);
    for (let i = 0; i < 50 && !seenMarker(); i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      parsed = parseSseChunk(buffer).events;
    }
    controller.abort();
    assert.ok(seenMarker(), "the live marker event arrived after the replay");
    return parsed.slice(0, -1);
  }

  test("GET /events replays the ring buffer as SSE; a tokenless subscriber never sees a private/ fact", async () => {
    const savedFolders = (events: Array<{ event?: string; data: string }>) =>
      events.filter((e) => e.event === "fact.saved").map((e) => (JSON.parse(e.data) as { fact: Fact }).fact.folder);

    const publicView = await readReplay();
    const types = publicView.map((e) => e.event ?? "");
    assert.ok(types.includes("session.captured"));
    assert.ok(types.includes("fact.retired"));
    assert.ok(types.includes("fact.saved"));
    assert.ok(savedFolders(publicView).length > 0);
    assert.ok(savedFolders(publicView).every((f) => !f.startsWith("private")), "no private/ fact.saved on the dashboard stream");

    const internalView = await readReplay("tok-dist");
    assert.ok(savedFolders(internalView).includes("private/health"), "the distiller's stream is complete");
    assert.equal((await api("/events", { token: "wrong", headers: { accept: "text/event-stream" } })).status, 401);
  });

  test("MCP endpoint: 401 JSON without a token", async () => {
    const raw = await api("/mcp", { method: "POST", json: { jsonrpc: "2.0", id: 1, method: "ping" }, headers: { accept: "application/json, text/event-stream" } });
    assert.equal(raw.status, 401);
    assert.match(((await raw.json()) as { error: string }).error, /bearer token/);

    // The SDK client surfaces our JSON error body (it drops the status from the message).
    const client = new Client({ name: "test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`));
    await assert.rejects(client.connect(transport), /missing or unknown bearer token/);
    await transport.close();
  });

  test("MCP endpoint through the SDK client: tools, whoami, refusal, context, save", async () => {
    const client = new Client({ name: "test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${running.url}/mcp`), {
      requestInit: { headers: { authorization: "Bearer tok-cc" } },
    });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((t) => t.name).sort(),
        ["canon_context", "canon_save", "canon_search", "canon_whoami"],
      );

      const whoami = (await client.callTool({ name: "canon_whoami", arguments: {} })) as ToolResult;
      assert.deepEqual(whoami.structuredContent, { client: "claude-code", read: ["projects", "career"], write: ["projects"] });
      assert.deepEqual(JSON.parse(whoami.content[0].text ?? ""), whoami.structuredContent);

      const refused = (await client.callTool({ name: "canon_search", arguments: { query: "typescript", folders: ["private"] } })) as ToolResult;
      assert.equal(refused.isError, true);
      assert.equal(refused.content[0].text, "refused: claude-code cannot read private. Call canon_whoami to see your folders.");
      assert.ok(events.some((e) => e.type === "access.denied" && e.tool === "canon_search" && e.folder === "private"));

      const search = (await client.callTool({ name: "canon_search", arguments: { query: "TypeScript Node" } })) as ToolResult;
      assert.equal(search.isError, undefined);
      const found = (search.structuredContent as { facts: Fact[] }).facts.map((f) => f.id);
      assert.deepEqual(found, [factB.id], "only the hot fact is indexed");

      const context = (await client.callTool({ name: "canon_context", arguments: { task: "Set up TypeScript on Node 22 for a new project", budget_tokens: 500 } })) as ToolResult;
      assert.equal(context.isError, undefined);
      const ctx = context.structuredContent as { facts: Array<{ id: string; relevance: number }>; candidates: number; tokens: number; enough: boolean };
      assert.equal(ctx.candidates, 1);
      assert.equal(typeof ctx.tokens, "number");
      assert.equal(typeof ctx.enough, "boolean");
      assert.ok(events.some((e) => e.type === "context.served" && e.client === "claude-code"));

      const save = (await client.callTool({ name: "canon_save", arguments: { text: "Remember: demo at 10:30", folder: "projects/canon" } })) as ToolResult;
      const saved = save.structuredContent as { queued: boolean; session_id: string };
      assert.equal(saved.queued, true);
      assert.ok(await running.store.getSession(saved.session_id));
    } finally {
      await client.close();
    }
  });
});

describe("POST /api/facts into scope groups", () => {
  let dir: string;
  let running: RunningServer;

  const groupTokens = new Map([...tokens, ["tok-leo", "leo"], ["tok-maya", "maya"], ["tok-dsp", "dispatcher"]]);

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "canon-groups-"));
    running = await startServer({ port: 0, dataDir: dir, tokens: groupTokens, grants: [...DEMO_GRANTS], judge: new FakeJudge(), retriever: new KeywordRetriever(), log: () => {} });
  });
  after(async () => {
    await running.close();
    await rm(dir, { recursive: true, force: true });
  });

  const post = (token: string, fact: Fact) =>
    fetch(`${running.url}/api/facts`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ facts: [{ fact, decision: decision("add", undefined, fact.folder) }] }),
    });

  test("the distiller files into the server's listed groups, never a folder outside its grant and the list", async () => {
    const inGroup: Fact = { ...factA, id: "fct_9a0b0001", folder: "deal/falcon" };
    assert.equal((await post("tok-dist", inGroup)).status, 200);
    assert.equal(running.store.getFact(inGroup.id)?.folder, "deal/falcon");

    const unlisted: Fact = { ...factA, id: "fct_9a0b0002", folder: "legal/osprey" };
    assert.equal((await post("tok-dist", unlisted)).status, 403);
    assert.equal(running.store.getFact(unlisted.id), undefined);

    const other: Fact = { ...inGroup, id: "fct_9a0b0003" };
    assert.equal((await post("tok-gpt", other)).status, 403, "only the distiller files into groups");
    assert.equal(running.store.getFact(other.id), undefined);
  });

  const factIds = async (token?: string) => {
    const res = await fetch(`${running.url}/api/facts`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
    return ((await res.json()) as { facts: Fact[] }).facts.map((f) => f.id);
  };

  /** Every SSE data frame the stream replays (the ring holds what the tests above emitted). */
  const replayed = async (token?: string): Promise<CanonEvent[]> => {
    const ctrl = new AbortController();
    const res = await fetch(`${running.url}/events`, { signal: ctrl.signal, headers: token ? { authorization: `Bearer ${token}` } : {} });
    const reader = res.body!.getReader();
    let text = "";
    const deadline = Date.now() + 300;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 100))]);
      if (!chunk || chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    ctrl.abort();
    return text
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => JSON.parse(l.slice(6)) as CanonEvent);
  };

  test("a deal fact reaches neither a tokenless caller nor a member: not in GET /api/facts, not on /events", async () => {
    assert.ok(!(await factIds()).includes("fct_9a0b0001"), "tokenless");
    assert.ok(!(await factIds("tok-leo")).includes("fct_9a0b0001"), "member");
    assert.ok((await factIds("tok-dist")).includes("fct_9a0b0001"), "the distiller reads the groups it files into");

    const deal = (events: CanonEvent[]) => events.filter((e) => e.type === "fact.saved" && e.fact.folder === "deal/falcon");
    assert.equal(deal(await replayed()).length, 0, "tokenless stream");
    assert.equal(deal(await replayed("tok-leo")).length, 0, "member stream");
    assert.equal(deal(await replayed("tok-maya")).length, 1, "a moderator sees it");
  });

  test("the public stream drops scopes events and strips titles", async () => {
    running.bus.emit({ type: "session.captured", session: { id: "ses_9a0b0001", client: "chatgpt", title: "Falcon LOI terms", messages: 2, ended: true } });
    running.bus.emit({ type: "triage.decided", session_id: "ses_9a0b0001", statement: "Falcon at $38.50", decision: "fact" } as never);
    const pub = await replayed();
    assert.ok(!JSON.stringify(pub).includes("Falcon"), JSON.stringify(pub));
    assert.ok(pub.some((e) => e.type === "session.captured" && e.session.id === "ses_9a0b0001"), "the capture itself still shows");
    assert.ok(JSON.stringify(await replayed("tok-dist")).includes("Falcon LOI terms"), "internal workers see everything");
  });

  test("the dispatcher reads an agent's scope rule but cannot change it", async () => {
    const rule = await fetch(`${running.url}/api/scope-rules/agt_leodesk`, { headers: { authorization: "Bearer tok-dsp" } });
    assert.equal(rule.status, 200);
    const put = await fetch(`${running.url}/api/scope-rules/agt_leodesk`, {
      method: "PUT",
      headers: { authorization: "Bearer tok-dsp", "content-type": "application/json" },
      body: JSON.stringify(await rule.json()),
    });
    assert.equal(put.status, 403);
  });
});
