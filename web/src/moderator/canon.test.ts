import assert from "node:assert/strict";
import { test } from "node:test";
import { CanonModClient } from "./canon.ts";
import { CanonClient } from "../member/canon.ts";

test("filing a fact does not clear its existing label barriers", async (t) => {
  const calls: { path: string; body: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (path: string, options: RequestInit) => { calls.push({ path, body: JSON.parse(options.body as string) }); return Response.json({}); });
  await new CanonModClient("https://preview.example", "test").fileFacts(["fct_ab12"], "market/public");
  assert.deepEqual(calls, [{ path: "https://preview.example/api/facts/fct_ab12/file", body: { group: "market/public" } }]);
});

test("member and moderator dispatch their agent's stored task", async (t) => {
  const posted: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_path: string, options: RequestInit) => {
    if (options.method === "GET") return Response.json({ agents: [{ id: "research-analyst", task: "Compare public manager earnings" }] });
    posted.push(JSON.parse(options.body as string));
    return Response.json({ id: "run_1234" });
  });
  await new CanonModClient("https://preview.example", "test").runAgent("research-analyst");
  await new CanonClient("https://preview.example", "test").runAgent("research-analyst");
  assert.deepEqual(posted, [{ task: "Compare public manager earnings" }, { task: "Compare public manager earnings" }]);
});

test("cookie clients omit bearer headers and keep existing agent exclusion barriers on edits", async (t) => {
  const posted: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_path: string, options: RequestInit) => {
    assert.equal(options.credentials, "same-origin");
    assert.equal((options.headers as Record<string, string>).authorization, undefined);
    if (options.method === "GET") return Response.json({ exclude: { groups: ["deal/*"], labels: ["taylor-mason"], text: "old" } });
    posted.push(JSON.parse(options.body as string));
    return Response.json({ build_id: "bld_1234" });
  });
  await new CanonClient("https://preview.example", "").updateAgent("research-analyst", { name: "Fixed name", task: "Revised task", exclusions: { groups: [], labels: [], text: ["firm operations"] }, docs: [], schedule: "Only when I press Run" });
  assert.deepEqual(posted, [{ task: "Revised task", exclusions: { groups: ["deal/*"], labels: ["taylor-mason"], text: ["firm operations"] } }]);
});

test("a canonical save event is displayed from the current authorized snapshot, never its old payload", async (t) => {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  t.mock.method(globalThis, "fetch", async (path: string) => path.endsWith("/events") ? new Response(stream) : Response.json({ facts: [{ id: "fct_1234", group: "market/public", statement: "Current permitted statement", labels: [], status: "hot" }] }));
  const seen: unknown[] = [];
  const client = new CanonClient("https://preview.example", "test");
  const close = client.subscribe((event) => seen.push(event), () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller!.enqueue(new TextEncoder().encode('event: fact.saved\ndata: {"type":"fact.saved","at":"now","fact":{"id":"fct_1234","statement":"Stale raw statement"}}\n\nevent: fact.saved\ndata: {"type":"fact.saved","at":"now","fact":{"id":"fct_revoked","statement":"Revoked raw statement"}}\n\n'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  close(); controller!.close();
  assert.deepEqual(seen, [{ type: "fact.saved", at: "now", fact: { id: "fct_1234", group: "market/public", statement: "Current permitted statement", labels: [], status: "hot" } }]);
});
