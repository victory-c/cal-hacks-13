import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ClaudeResponder, EchoResponder } from "./responder.ts";
import { captureWarnings, fakeFetch, withEnv } from "./test-helpers.ts";

/** A Messages API response as the real API shapes it: a thinking block first, text read by type. */
function message(text: string, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      id: "msg_01",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5-5",
      stop_reason: "end_turn",
      stop_details: null,
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "text", text },
      ],
      usage: { input_tokens: 321, output_tokens: 45 },
      ...extra,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("ClaudeResponder", () => {
  test("posts to /v1/messages with the skill's headers, context + question in one user turn, and records usage", async () => {
    const { fetch, calls } = fakeFetch([() => message("You interned at Databricks on Spark SQL.")]);
    await withEnv({ ANTHROPIC_BASE_URL: "http://api.test/" }, async () => {
      const r = new ClaudeResponder({ apiKey: "test-key", fetch });
      assert.equal(r.model, "claude-sonnet-5-5");
      assert.equal(r.simulated, false);
      const a = await r.answer("CTX LINE", "Where did I intern?");

      assert.equal(calls[0].url, "http://api.test/v1/messages");
      const headers = calls[0].init.headers as Record<string, string>;
      assert.equal(headers["x-api-key"], "test-key");
      assert.equal(headers["anthropic-version"], "2026-10-21");
      const body = calls[0].body as Record<string, unknown>;
      assert.equal(body.model, "claude-sonnet-5-5");
      assert.equal(body.max_tokens, 4096);
      assert.equal("temperature" in body, false);
      assert.equal("thinking" in body, false, "Sonnet 5.5 runs adaptive thinking by default");
      assert.equal("tool_choice" in body, false);
      const messages = body.messages as Array<{ role: string; content: string }>;
      assert.equal(messages.length, 1);
      assert.equal(messages[0].role, "user");
      assert.ok(messages[0].content.includes("CONTEXT:\nCTX LINE") && messages[0].content.includes("QUESTION:\nWhere did I intern?"));

      assert.equal(a.text, "You interned at Databricks on Spark SQL.");
      assert.deepEqual(a.usage, { input_tokens: 321, output_tokens: 45 });
      assert.equal(typeof a.ms, "number");
      assert.equal(a.simulated, undefined);
    });
  });

  test("empty context is labelled (empty) rather than sent as a blank", async () => {
    const { fetch, calls } = fakeFetch([() => message("I do not know.")]);
    await withEnv({ ANTHROPIC_BASE_URL: "http://api.test" }, async () => {
      await new ClaudeResponder({ apiKey: "k", fetch }).answer("   ", "q");
      const messages = (calls[0].body as { messages: Array<{ content: string }> }).messages;
      assert.ok(messages[0].content.includes("CONTEXT:\n(empty)"));
    });
  });

  test("a refusal, an HTTP error and missing usage are each reported, never fabricated", async () => {
    await withEnv({ ANTHROPIC_BASE_URL: "http://api.test" }, async () => {
      const refused = fakeFetch([() => message("", { stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms" }, content: [] })]);
      await assert.rejects(new ClaudeResponder({ apiKey: "k", fetch: refused.fetch }).answer("c", "q"), /Claude declined to answer \(category: general_harms\)/);

      const bad = fakeFetch([() => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens: must be > 0" } }), { status: 400 })]);
      await assert.rejects(new ClaudeResponder({ apiKey: "k", fetch: bad.fetch }).answer("c", "q"), /ClaudeResponder: HTTP 400: max_tokens: must be > 0/);

      const noUsage = fakeFetch([() => message("ok", { usage: undefined })]);
      const { result, warnings } = await captureWarnings(() => new ClaudeResponder({ apiKey: "k", fetch: noUsage.fetch }).answer("c", "q"));
      assert.equal(result.usage, undefined);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /no usage/);
    });
  });

  test("needs an API key from opts or env", async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined }, () => {
      assert.throws(() => new ClaudeResponder(), /ANTHROPIC_API_KEY is not set.*--dry/);
    });
    await withEnv({ ANTHROPIC_API_KEY: "from-env" }, () => {
      assert.equal(new ClaudeResponder().name, "claude");
    });
  });
});

describe("EchoResponder", () => {
  test("never calls a model: simulated, no usage, context truncated", async () => {
    const r = new EchoResponder();
    assert.equal(r.simulated, true);
    const a = await r.answer("x".repeat(2000), "q");
    assert.equal(a.simulated, true);
    assert.equal(a.usage, undefined);
    assert.match(a.text, /^SIMULATED — no model was called/);
    assert.ok(a.text.includes("2000 chars"));
    assert.ok(a.text.length < 900);
  });
});
