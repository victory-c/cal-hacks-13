import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEMO_GRANTS, FakeJudge, parseSseChunk } from "@canon/shared";
import type { CanonEvent, Fact, SaveDecision } from "@canon/shared";

import { startServer } from "./app.ts";
import type { RunningServer } from "./app.ts";
import { KeywordRetriever } from "./retrieval/keyword.ts";

const tokens = new Map([
  ["cc", "claude-code"], ["gpt", "chatgpt"], ["team", "teammate-cursor"],
  ["worker", "distiller"], ["orphan", "no-grant"],
]);

const fact = (id: string, folder: Fact["folder"]): Fact => ({
  id, folder, statement: `Synthetic fact in ${folder}`, tier: "hot", jev_keep: 0.9,
  source: { client: "claude-code", session: "ses_eeee0001" }, updated: "2026-10-24",
});
const project = fact("fct_eeee0001", "projects/test");
const career = fact("fct_eeee0002", "career/skills");
const team = fact("fct_eeee0003", "team/plans");
const privateFact = fact("fct_eeee0004", "private/health");
const decision = (f: Fact): SaveDecision => ({
  action: "add", folder: f.folder, tier: f.tier, keep_p: 0.9, folder_p: 0.9, judge: "fake",
});
let markerId = 987654321;

async function isolated(run: (server: RunningServer) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "canon-event-visibility-"));
  const server = await startServer({
    port: 0, dataDir: dir, tokens, grants: [...DEMO_GRANTS],
    judge: new FakeJudge(), retriever: new KeywordRetriever(), log: () => {},
  });
  try {
    for (const f of [project, career, team, privateFact]) await server.store.putFact(f);
    await run(server);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Read replay plus optionally emitted live events, ending at an explicit live marker. */
async function view(server: RunningServer, token?: string, live?: () => Promise<void> | void): Promise<CanonEvent[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`${server.url}/events`, { headers, signal: controller.signal });
    assert.equal(res.status, 200);
    await live?.();
    const markerFacts = ++markerId;
    server.bus.emit({ type: "server.started", facts: markerFacts, sessions: 0 });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const next = await reader.read();
      assert.equal(next.done, false, "SSE remains open through the live marker");
      buffer += decoder.decode(next.value, { stream: true });
      const events = parseSseChunk(buffer).events.map(frame => JSON.parse(frame.data) as CanonEvent);
      const marker = events.findIndex(e => e.type === "server.started" && e.facts === markerFacts);
      if (marker !== -1) return events.slice(0, marker);
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

test("authenticated SSE replay uses the same folder grant as fact reads", async () => isolated(async server => {
  for (const f of [project, career, team, privateFact]) server.bus.emit({ type: "fact.saved", fact: f, decision: decision(f) });
  const events = await view(server, "gpt");
  assert.deepEqual(events.filter(e => e.type === "fact.saved").map(e => e.fact.id), [career.id]);
}));

test("authenticated SSE filters live facts without widening the tokenless dashboard", async () => isolated(async server => {
  const events = await view(server, "team", () => {
    for (const f of [project, career, team, privateFact]) server.bus.emit({ type: "fact.saved", fact: f, decision: decision(f) });
  });
  assert.deepEqual(events.filter(e => e.type === "fact.saved").map(e => e.fact.id), [team.id]);
  const publicEvents = await view(server);
  assert.deepEqual(publicEvents.filter(e => e.type === "fact.saved").map(e => e.fact.id), [project.id, career.id, team.id]);
  assert.equal((await view(server, "worker")).filter(e => e.type === "fact.saved").length, 4);
}));

test("an authenticated token without a grant cannot open SSE", async () => isolated(async server => {
  const response = await fetch(`${server.url}/events`, { headers: { authorization: "Bearer orphan" } });
  try { assert.equal(response.status, 403); } finally { await response.body?.cancel(); }
}));

test("client streams isolate session titles, extraction metadata and request tasks", async () => isolated(async server => {
  for (const [id, client] of [["ses_eeee0011", "claude-code"], ["ses_eeee0012", "chatgpt"]]) {
    await server.store.putSession({ id, client, started_at: "2026-10-24T00:00:00Z", messages: [] });
    server.bus.emit({ type: "session.captured", session: { id, client, title: `${client} confidential title`, messages: 0, ended: true } });
    server.bus.emit({ type: "distill.started", session_id: id, engine: "droid" });
    server.bus.emit({ type: "distill.finished", session_id: id, engine: "droid", facts: 1, duration_ms: 1, plan: "Raw confidential plan" });
    server.bus.emit({ type: "context.served", client, task: `${client} confidential task`, fact_ids: [career.id], candidates: 1, tokens: 1, latency_ms: 1, enough: true });
    server.bus.emit({ type: "access.denied", client, tool: "canon_search", folder: "career" });
  }
  server.bus.emit({ type: "context.served", client: "claude-code", task: "Private context", fact_ids: [privateFact.id], candidates: 1, tokens: 1, latency_ms: 1, enough: true });
  server.bus.emit({ type: "access.denied", client: "claude-code", tool: "POST /api/facts", folder: privateFact.folder });
  const events = await view(server, "cc");
  assert.deepEqual(events.filter(e => e.type === "session.captured").map(e => e.session.client), ["claude-code"]);
  assert.deepEqual(events.filter(e => e.type === "context.served").map(e => e.task), ["claude-code confidential task"]);
  assert.equal(events.filter(e => e.type === "distill.started").length, 1);
  assert.equal(events.filter(e => e.type === "distill.finished").length, 1);
  assert.ok(events.filter(e => e.type === "distill.finished").every(e => e.plan === undefined));
  assert.deepEqual(events.filter(e => e.type === "access.denied").map(e => [e.client, e.folder]), [["claude-code", "career"]]);
  assert.doesNotMatch(JSON.stringify(events), /chatgpt confidential|Raw confidential plan|private\/health/);
  const publicEvents = await view(server);
  assert.equal(publicEvents.filter(e => e.type === "session.captured").length, 2, "team dashboard retains capture telemetry");
  assert.equal(publicEvents.filter(e => e.type === "distill.finished").length, 2);
  assert.ok(publicEvents.filter(e => e.type === "distill.finished").every(e => e.plan === undefined));
  assert.doesNotMatch(JSON.stringify(publicEvents), /Private context|private\/health|fct_eeee0004/);
  const internal = await view(server, "worker");
  assert.equal(internal.filter(e => e.type === "distill.finished" && e.plan === "Raw confidential plan").length, 2);
  assert.ok(internal.some(e => e.type === "context.served" && e.task === "Private context"));
}));

test("retirement events require both readable ids, including during a live API write", async () => isolated(async server => {
  const replacement = { ...career, id: "fct_eeee0021", supersedes: career.id };
  const events = await view(server, "gpt", async () => {
    const response = await fetch(`${server.url}/api/facts`, {
      method: "POST", headers: { authorization: "Bearer worker", "content-type": "application/json" },
      body: JSON.stringify({ facts: [{ fact: replacement, decision: { ...decision(replacement), action: "supersede", supersedes: career.id } }] }),
    });
    assert.equal(response.status, 200);
  });
  assert.deepEqual(events.filter(e => e.type === "fact.retired").map(e => [e.id, e.superseded_by]), [[career.id, replacement.id]]);
  const crossFolder = { ...career, id: "fct_eeee0022", supersedes: privateFact.id };
  await server.store.putFact(crossFolder);
  server.bus.emit({ type: "fact.retired", id: privateFact.id, superseded_by: crossFolder.id });
  server.bus.emit({ type: "fact.saved", fact: crossFolder, decision: { ...decision(crossFolder), action: "supersede", supersedes: privateFact.id } });
  for (const token of ["gpt", undefined]) {
    const external = await view(server, token);
    assert.doesNotMatch(JSON.stringify(external), new RegExp(privateFact.id));
    const saved = external.find(e => e.type === "fact.saved" && e.fact.id === crossFolder.id);
    assert.ok(saved && saved.type === "fact.saved");
    assert.equal(saved.fact.supersedes, undefined);
    assert.equal(saved.decision.supersedes, undefined);
    assert.equal(saved.decision.action, "add", "the newly visible fact appears as an addition");
  }
  const internal = await view(server, "worker");
  assert.ok(internal.some(e => e.type === "fact.retired" && e.id === privateFact.id));
  assert.ok(internal.some(e => e.type === "fact.saved" && e.fact.id === crossFolder.id && e.fact.supersedes === privateFact.id));
}));

test("replay rechecks current folders and hides unknown fact references", async () => isolated(async server => {
  server.bus.emit({ type: "fact.saved", fact: career, decision: decision(career) });
  await server.store.putFact({ ...career, folder: "private/health" });
  server.bus.emit({ type: "fact.retired", id: "fct_ffff1111", superseded_by: project.id });
  server.bus.emit({ type: "context.served", client: "claude-code", task: "Unknown references", fact_ids: ["fct_ffff1111"], candidates: 1, tokens: 1, latency_ms: 1, enough: true });
  for (const token of ["cc", undefined]) {
    const events = await view(server, token);
    assert.doesNotMatch(JSON.stringify(events), /fct_eeee0002|fct_ffff1111|Unknown references/);
  }
  assert.ok((await view(server, "worker")).some(e => e.type === "fact.saved" && e.fact.id === career.id));
}));
