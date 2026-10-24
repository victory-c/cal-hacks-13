import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ClaudeDistiller, asFolder, transcript } from "./claude.ts";
import { loadFixture, quiet, readBody, serve, withEnv } from "../test-helpers.ts";

/** A Messages API response as the real API shapes it: blocks read by type, not position. */
function messageResponse(input: unknown, stop_reason = "tool_use") {
  return {
    id: "msg_01",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    stop_reason,
    stop_details: null,
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "tool_use", id: "toolu_01", name: "emit_facts", input },
    ],
    usage: { input_tokens: 812, output_tokens: 143 },
  };
}

describe("ClaudeDistiller", () => {
  test("sends one strict emit_facts tool with auto tool_choice to /v1/messages and maps the call to drafts", async () => {
    const fixture = loadFixture();
    let seen: { headers: Record<string, unknown>; body: Record<string, unknown>; path: string } | undefined;
    const { url, close } = await serve(async (req, res) => {
      seen = { headers: req.headers, body: JSON.parse(await readBody(req)), path: req.url ?? "" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          messageResponse({
            plan: "Kept the shipped hook, the folder decision and the internship target; dropped the plan chatter.",
            facts: [
              { statement: "Built the Claude Code capture hook for Canon", folder: "projects", detail: null },
              { statement: "Targeting backend internships for summer 2027", folder: "career", detail: "Said while wiring the hook." },
              { statement: "Built the Claude Code capture hook for Canon", folder: "projects", detail: null }, // dup
              { statement: "Decided the folder layout", folder: "notes/random", detail: null }, // bad folder → kept, folder dropped (Jev files it)
              { statement: "   ", folder: null, detail: null }, // empty → skipped
            ],
          }),
        ),
      );
    });
    try {
      await withEnv({ ANTHROPIC_BASE_URL: `${url}/` }, async () => {
        const distiller = new ClaudeDistiller({ apiKey: "test-key" });
        assert.equal(distiller.name, "claude");
        const result = await distiller.distill(fixture);

        assert.ok(seen);
        assert.equal(seen.path, "/v1/messages");
        assert.equal(seen.headers["x-api-key"], "test-key");
        assert.equal(seen.headers["anthropic-version"], "2026-10-21");
        assert.equal(seen.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
        assert.equal(seen.body.model, "claude-sonnet-5-5");
        assert.equal(seen.body.max_tokens, 4096);
        assert.deepEqual(seen.body.tool_choice, { type: "auto" }, "forced tool_choice is a 400 on claude-sonnet-5-5");
        assert.equal(seen.body.fallbacks, "default");
        assert.deepEqual(seen.body.output_config, { effort: "medium" });
        assert.equal("thinking" in seen.body, false, "adaptive thinking is the default; nothing to send");
        assert.equal("temperature" in seen.body, false);
        const tools = seen.body.tools as Array<{ name: string; strict: boolean; input_schema: Record<string, unknown> }>;
        assert.equal(tools.length, 1);
        assert.equal(tools[0].name, "emit_facts");
        assert.equal(tools[0].strict, true);
        assert.deepEqual(tools[0].input_schema.required, ["plan", "facts"]);
        assert.equal(tools[0].input_schema.additionalProperties, false);
        assert.ok(String(seen.body.system).includes("emit_facts") && String(seen.body.system).includes("career, projects, team, private"));
        const messages = seen.body.messages as Array<{ role: string; content: string }>;
        assert.equal(messages.length, 1);
        assert.equal(messages[0].role, "user");
        assert.ok(messages[0].content.includes("[user]\nLet's wire the Claude Code capture hook"));
        assert.ok(messages[0].content.includes("pr: https://github.com/victory-c/cal-hacks-13/pull/7"));

        assert.equal(result.simulated, false);
        assert.equal(result.plan, "Kept the shipped hook, the folder decision and the internship target; dropped the plan chatter.");
        assert.deepEqual(result.usage, { input_tokens: 812, output_tokens: 143 });
        assert.deepEqual(result.drafts, [
          { statement: "Built the Claude Code capture hook for Canon", folder: "projects", source: { client: "claude-code", session: fixture.id, pr: fixture.meta?.pr } },
          { statement: "Targeting backend internships for summer 2027", folder: "career", detail: "Said while wiring the hook.", source: { client: "claude-code", session: fixture.id, pr: fixture.meta?.pr } },
          { statement: "Decided the folder layout", source: { client: "claude-code", session: fixture.id, pr: fixture.meta?.pr } },
        ]);
      });
    } finally {
      await close();
    }
  });

  test("a refusal, an HTTP error and a response with no tool call each fail with a clear message", async () => {
    let reply: { status: number; body: unknown } = {
      status: 200,
      body: { ...messageResponse({}, "refusal"), content: [], stop_details: { type: "refusal", category: "general_harms" } },
    };
    const { url, close } = await serve((_req, res) => {
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
    try {
      await withEnv({ ANTHROPIC_BASE_URL: url }, async () => {
        const distiller = new ClaudeDistiller({ apiKey: "test-key" });
        const session = loadFixture();
        await assert.rejects(distiller.distill(session), /declined to distill .*general_harms/);

        reply = { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "tool_choice: type \"tool\" and \"any\" are not supported for this model." } } };
        await assert.rejects(distiller.distill(session), /HTTP 400: tool_choice: type "tool" and "any" are not supported/);

        reply = { status: 200, body: { ...messageResponse({}, "end_turn"), content: [{ type: "text", text: "Nothing durable here." }] } };
        await assert.rejects(distiller.distill(session), /no emit_facts call .*stop_reason: end_turn.*Claude said: Nothing durable here/);

        reply = { status: 200, body: messageResponse({ plan: "cut", facts: [{ statement: "Built it", folder: null, detail: null }] }, "max_tokens") };
        const { result, lines } = await quiet(() => distiller.distill(session));
        assert.equal(result.drafts.length, 1);
        assert.equal(result.drafts[0].folder, undefined);
        assert.ok(lines.some((l) => l.includes("hit max_tokens=4096")), lines.join("\n"));
      });
    } finally {
      await close();
    }
  });

  test("asFolder accepts top folders and <top>/<sub>, rejects everything else", () => {
    assert.equal(asFolder("career"), "career");
    assert.equal(asFolder("career/projects"), "career/projects");
    assert.equal(asFolder("/projects/canon/"), "projects/canon");
    assert.equal(asFolder("inbox"), undefined, "the inbox is Jev's call, not the engine's");
    assert.equal(asFolder("notes"), undefined);
    assert.equal(asFolder("career//x"), undefined);
    assert.equal(asFolder("career/../private"), undefined);
    assert.equal(asFolder(null), undefined);
  });

  test("transcript puts metadata first and one block per message", () => {
    const t = transcript({ id: "ses_00000001", client: "chatgpt", started_at: "2026-10-24T00:00:00.000Z", meta: { url: "https://chatgpt.com/c/1" }, messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] });
    assert.equal(t, "SESSION\nclient: chatgpt\nurl: https://chatgpt.com/c/1\nstarted: 2026-10-24T00:00:00.000Z (still running)\n\nTRANSCRIPT\n[user]\nhi\n\n[assistant]\nhello");
  });
});
