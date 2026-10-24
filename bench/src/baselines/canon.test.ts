import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { describe, test } from "node:test";

import { formatSseEvent } from "@canon/shared";
import type { CanonEvent, ContextOutput, Fact } from "@canon/shared";

import { readBody, serve } from "../test-helpers.ts";
import type { BenchTask } from "../types.ts";
import { CanonBaseline, clientTokens, formatContext, toContextOutput, waitForDistill } from "./canon.ts";

const now = () => new Date().toISOString();
const fact = (session: string, statement = "Interned at Databricks on Spark SQL"): Fact => ({
  id: "fct_0001",
  statement,
  folder: "career",
  tier: "hot",
  jev_keep: 0.9,
  source: { client: "chatgpt", session },
  updated: "2026-10-24",
});
const saved = (session: string, at = now()): CanonEvent => ({
  type: "fact.saved",
  at,
  fact: fact(session),
  decision: { tier: "hot", folder: "career", action: "add", keep_p: 0.9, folder_p: 0.8, judge: "fake" },
});
const finished = (session_id: string, engine: "heuristic" | "droid" = "heuristic"): CanonEvent => ({ type: "distill.finished", at: now(), session_id, engine, facts: 1, duration_ms: 12 });

/** An /events endpoint that runs `script` once the client is connected. */
async function sseServer(script: (res: ServerResponse) => void) {
  return serve((req, res) => {
    if (req.url !== "/events") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders(); // Node holds headers until the first write; an SSE client needs them now
    script(res);
  });
}

describe("waitForDistill", () => {
  test("ignores replayed history, settles when every session has distill.finished", { timeout: 5000 }, async () => {
    const old = new Date(Date.now() - 60_000).toISOString();
    const { url, close } = await sseServer((res) => {
      res.write(formatSseEvent(saved("ses_aa000001", old), "1")); // replayed from an earlier run
      setTimeout(() => {
        res.write(formatSseEvent({ type: "distill.started", at: now(), session_id: "ses_aa000001", engine: "droid" }));
        res.write(formatSseEvent(saved("ses_aa000001")));
        res.write(formatSseEvent(finished("ses_aa000002", "droid")));
        res.write(formatSseEvent(finished("ses_aa000001", "droid")));
      }, 30);
    });
    try {
      const w = waitForDistill(`${url}/events`, "tok", ["ses_aa000001", "ses_aa000002"], { timeoutMs: 4000, quietMs: 1000 });
      await w.opened;
      const s = await w.settled;
      assert.equal(s.how, "distill.finished");
      assert.equal(s.facts_saved, 1, "the replayed old fact.saved does not count");
      assert.deepEqual(s.engines, ["droid"]);
      assert.deepEqual(s.finished, ["ses_aa000002", "ses_aa000001"]);
    } finally {
      await close();
    }
  });

  test("without distill.finished, settles after a quiet period once every session has a fact", { timeout: 5000 }, async () => {
    const { url, close } = await sseServer((res) => {
      setTimeout(() => res.write(formatSseEvent(saved("ses_bb000001"))), 20);
      setTimeout(() => res.write(formatSseEvent(saved("ses_bb000001"))), 60);
    });
    try {
      const w = waitForDistill(`${url}/events`, "tok", ["ses_bb000001"], { timeoutMs: 4000, quietMs: 80 });
      const s = await w.settled;
      assert.equal(s.how, "quiet");
      assert.equal(s.facts_saved, 2);
      assert.ok(s.ms >= 60 + 80 - 5, `quiet period restarts on each fact (took ${s.ms} ms)`);
    } finally {
      await close();
    }
  });

  test("times out when nothing arrives, and reports it", { timeout: 5000 }, async () => {
    const { url, close } = await sseServer(() => undefined);
    try {
      const s = await waitForDistill(`${url}/events`, "tok", ["ses_cc000001"], { timeoutMs: 100, quietMs: 50 }).settled;
      assert.equal(s.how, "timeout");
      assert.equal(s.facts_saved, 0);
    } finally {
      await close();
    }
  });

  test("an unreachable server rejects `opened` fast instead of retrying for a minute", { timeout: 5000 }, async () => {
    const { url, close } = await serve(() => undefined);
    await close(); // a port that was just free: connection refused
    const w = waitForDistill(`${url}/events`, "tok", ["ses_dd000001"], { timeoutMs: 4000, quietMs: 50 });
    await assert.rejects(w.opened, /Could not open the event stream/);
    assert.equal((await w.settled).how, "stopped");
  });

  test("a server that accepts the socket but never sends headers trips the open timeout", { timeout: 5000 }, async () => {
    const { url, close } = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" }); // no flush, no write: headers never leave
    });
    try {
      const w = waitForDistill(`${url}/events`, "tok", ["ses_ff000001"], { timeoutMs: 4000, quietMs: 50, openTimeoutMs: 100 });
      await assert.rejects(w.opened, /did not open within 100 ms/);
      assert.equal((await w.settled).how, "stopped");
    } finally {
      await close();
    }
  });
});

describe("toContextOutput / formatContext", () => {
  const output: ContextOutput = {
    facts: [
      { id: "fct_0001", statement: "Interned at Databricks on the Spark SQL team", folder: "career", updated: "2026-10-24", source: { client: "chatgpt", session: "ses_1" }, relevance: 0.93, detail: "Cut planning latency 30%.\nShipped in 17.1." },
      { id: "fct_0002", statement: "Graduating May 2028", folder: "career", updated: "2026-10-24", source: { client: "chatgpt", session: "ses_1" }, relevance: 0.71 },
    ],
    tokens: 60,
    latency_ms: 90,
    enough: false,
    missing: "which release it shipped in",
    candidates: 7,
  };

  test("prefers structuredContent, falls back to the text block, rejects anything else", () => {
    assert.deepEqual(toContextOutput({ text: "", structured: output, isError: false, raw: {} }), output);
    assert.deepEqual(toContextOutput({ text: JSON.stringify(output), isError: false, raw: {} }), output);
    assert.throws(() => toContextOutput({ text: "Sorry, no facts", isError: false, raw: {} }), /returned no ContextOutput/);
  });

  test("renders one line per fact, indented detail, and the not-enough note", () => {
    assert.equal(
      formatContext(output),
      [
        "Facts from Canon (2 of 7 candidates):",
        "- Interned at Databricks on the Spark SQL team [career, 2026-10-24]",
        "  Cut planning latency 30%.",
        "  Shipped in 17.1.",
        "- Graduating May 2028 [career, 2026-10-24]",
        "Canon says this may not be enough: which release it shipped in",
      ].join("\n"),
    );
    assert.equal(formatContext({ ...output, facts: [], missing: undefined }), "Facts from Canon: none relevant to this task.");
  });
});

test("clientTokens inverts CANON_CLIENT_TOKENS to client → token", () => {
  const m = clientTokens("claude-code=dev-cc, chatgpt=dev-gpt,broken,=x");
  assert.deepEqual([...m.entries()], [["claude-code", "dev-cc"], ["chatgpt", "dev-gpt"]]);
});

describe("CanonBaseline.prepare against a fake Canon server", () => {
  const task: BenchTask = {
    id: "t00-example",
    title: "x",
    from_client: "chatgpt",
    to_client: "claude-code",
    folder: "career",
    setup_sessions: [{ id: "ses_ee000001", client: "chatgpt", started_at: "2026-09-14T19:02:00Z", messages: [{ role: "user", content: "I interned at Databricks." }] }],
    question: "Where did I intern?",
    answer_key: { must_include: ["Databricks"] },
  };
  const contextOutput: ContextOutput = {
    facts: [{ id: "fct_0001", statement: "Interned at Databricks on Spark SQL", folder: "career", updated: "2026-10-24", source: { client: "chatgpt", session: "ses_ee000001" }, relevance: 0.9 }],
    tokens: 12,
    latency_ms: 40,
    enough: true,
    candidates: 3,
  };

  test("posts sessions as the from client, waits for the distiller, asks canon_context as the to client", { timeout: 10_000 }, async () => {
    const posted: Array<{ auth: string | undefined; body: Record<string, unknown> }> = [];
    const mcp: Array<{ auth: string | undefined; body: Record<string, unknown> }> = [];
    const streams = new Set<ServerResponse>();
    const { url, close } = await serve(async (req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, facts: 1, sessions: 1, uptime_s: 1, judge: "fake", retriever: "keyword" }));
      } else if (req.url === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        streams.add(res);
      } else if (req.url === "/api/sessions" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        posted.push({ auth: req.headers.authorization, body });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: body.id, updated: false }));
        // The distiller finishes a moment later and the server tells every subscriber.
        setTimeout(() => {
          for (const s of streams) {
            s.write(formatSseEvent(saved(body.id as string)));
            s.write(formatSseEvent(finished(body.id as string)));
          }
        }, 20);
      } else if (req.url === "/mcp" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        mcp.push({ auth: req.headers.authorization, body });
        if (body.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "canon", version: "0" } } }));
        } else if (body.method === "notifications/initialized") {
          res.writeHead(202).end();
        } else {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(contextOutput) }], structuredContent: contextOutput } }));
        }
      } else if (req.url === "/mcp" && req.method === "DELETE") {
        res.writeHead(200).end();
      } else {
        res.writeHead(404).end();
      }
    });
    try {
      const baseline = new CanonBaseline({ serverUrl: url, tokens: new Map([["chatgpt", "tok-gpt"], ["claude-code", "tok-cc"]]), settleTimeoutMs: 5000, quietMs: 2000, budgetTokens: 800 });
      const p = await baseline.prepare(task);

      assert.equal(posted.length, 1);
      assert.equal(posted[0].auth, "Bearer tok-gpt");
      assert.equal(posted[0].body.id, "ses_ee000001");
      assert.equal(typeof posted[0].body.ended_at, "string", "the session is posted as ended so the final distill runs");

      const call = mcp.find((m) => m.body.method === "tools/call");
      assert.ok(call);
      assert.equal(call.auth, "Bearer tok-cc");
      assert.deepEqual(call.body.params, { name: "canon_context", arguments: { task: "Where did I intern?", budget_tokens: 800 } });

      assert.equal(p.context, "Facts from Canon (1 of 3 candidates):\n- Interned at Databricks on Spark SQL [career, 2026-10-24]");
      assert.equal(p.tokens_injected_est, Math.ceil(p.context.length / 4));
      assert.equal(p.simulated, true, "fake judge + heuristic distiller → simulated");
      const detail = p.detail as { health: { judge: string }; settle: { how: string; facts_saved: number }; canon_context: { candidates: number; fact_ids: string[] } };
      assert.equal(detail.health.judge, "fake");
      assert.equal(detail.settle.how, "distill.finished");
      assert.equal(detail.settle.facts_saved, 1);
      assert.deepEqual(detail.canon_context.fact_ids, ["fct_0001"]);
      assert.ok(p.latency_ms >= 0);
    } finally {
      for (const s of streams) s.end();
      await close();
    }
  });

  test("a missing client token and an unreachable server each fail with a clear message", async () => {
    const noToken = new CanonBaseline({ serverUrl: "http://127.0.0.1:9", tokens: new Map([["chatgpt", "x"]]) });
    await assert.rejects(noToken.prepare(task), /No token for client "claude-code"\. Add "claude-code=<token>" to CANON_CLIENT_TOKENS/);
    const noEnv = new CanonBaseline({ serverUrl: "http://127.0.0.1:9", tokens: new Map() });
    await assert.rejects(noEnv.prepare(task), /CANON_CLIENT_TOKENS is not set: copy \.env\.example to \.env/);

    const { url, close } = await serve(() => undefined);
    await close();
    const down = new CanonBaseline({ serverUrl: url, tokens: new Map([["chatgpt", "x"], ["claude-code", "y"]]) });
    await assert.rejects(down.prepare(task), /Canon server at http:\/\/127\.0\.0\.1:\d+ is not reachable .*npm run dev -w server/);
  });
});
