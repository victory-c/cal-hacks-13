import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { estimateTokens } from "@canon/shared";

import type { BenchTask } from "../types.ts";
import { FullHistoryBaseline, transcript } from "./full-history.ts";
import { NoMemoryBaseline } from "./no-memory.ts";

const task: BenchTask = {
  id: "t01-x",
  title: "x",
  from_client: "chatgpt",
  to_client: "claude-code",
  folder: "career",
  setup_sessions: [
    {
      id: "ses_01000001",
      client: "chatgpt",
      title: "Resume bullets",
      started_at: "2026-09-14T19:02:00Z",
      messages: [
        { role: "user", content: "I interned at Databricks on Spark SQL." },
        { role: "assistant", content: "Great, here is a bullet." },
      ],
    },
    { id: "ses_01000002", client: "chatgpt", started_at: "2026-10-02T02:15:00Z", messages: [{ role: "user", content: "Stripe closes October 31." }] },
  ],
  question: "q",
  answer_key: { must_include: ["Databricks"] },
};

describe("full-history baseline", () => {
  test("injects every message of every session, in order, with a header per session", async () => {
    const p = await new FullHistoryBaseline().prepare(task);
    assert.equal(
      p.context,
      [
        "## Session ses_01000001 — chatgpt: Resume bullets (2026-09-14T19:02:00Z)",
        "user: I interned at Databricks on Spark SQL.",
        "assistant: Great, here is a bullet.",
        "",
        "## Session ses_01000002 — chatgpt (2026-10-02T02:15:00Z)",
        "user: Stripe closes October 31.",
      ].join("\n"),
    );
    assert.equal(p.context, transcript(task.setup_sessions));
  });

  test("tokens_injected_est is estimateTokens(context), i.e. ceil(chars / 4), and is labelled est.", async () => {
    const p = await new FullHistoryBaseline().prepare(task);
    assert.equal(p.tokens_injected_est, estimateTokens(p.context));
    assert.equal(p.tokens_injected_est, Math.ceil(p.context.length / 4));
    assert.equal(p.simulated, undefined, "a real baseline, only the token figure is an estimate");
    assert.deepEqual(p.detail, { sessions: 2, messages: 3 });
    assert.ok(p.latency_ms >= 0);
  });
});

test("no-memory baseline injects nothing", async () => {
  const p = await new NoMemoryBaseline().prepare(task);
  assert.deepEqual(p, { context: "", tokens_injected_est: 0, latency_ms: 0 });
});
