import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { CapturedSession } from "@canon/shared";
import { HeuristicDistiller, guessFolder } from "./heuristic.ts";
import { loadFixture } from "../test-helpers.ts";

describe("HeuristicDistiller", () => {
  test("the fixture yields at least two drafts with folders, labelled simulated", async () => {
    const session = loadFixture();
    const result = await new HeuristicDistiller().distill(session);

    assert.equal(result.simulated, true);
    assert.match(result.plan ?? "", /^heuristic: \d+ candidate sentences from 8 messages \(simulated\)$/);
    assert.ok(result.drafts.length >= 2, `expected >= 2 drafts, got ${result.drafts.length}`);
    assert.ok(result.drafts.length <= 8);
    const withFolder = result.drafts.filter((d) => d.folder);
    assert.ok(withFolder.length >= 2, "at least two drafts carry a folder guess");
    assert.ok(result.drafts.some((d) => d.folder === "career"), "the internship line lands in career");
    assert.ok(result.drafts.some((d) => d.folder === "projects"), "the hook/PR lines land in projects");
    for (const d of result.drafts) {
      assert.deepEqual(d.source, { client: "claude-code", session: "ses_b2f1c9a4", pr: "https://github.com/victory-c/cal-hacks-13/pull/7" });
      assert.ok(d.statement.length <= 200);
      assert.doesNotMatch(d.statement, /^I\s/, "first person without the pronoun");
    }
  });

  test("dedupes, caps at 8 and keeps counting candidates for the plan", async () => {
    const line = "We decided to ship it.";
    const messages = Array.from({ length: 12 }, (_, i) => ({ role: "user" as const, content: `${line} Built thing number ${i}.` }));
    const session: CapturedSession = { id: "ses_0000aaaa", client: "cursor", started_at: "2026-10-24T00:00:00.000Z", messages };
    const result = await new HeuristicDistiller().distill(session);
    assert.equal(result.drafts.length, 8);
    assert.equal(result.drafts.filter((d) => d.statement === "Decided to ship it.").length, 1, "duplicate sentence appears once");
    assert.equal(result.plan, "heuristic: 24 candidate sentences from 12 messages (simulated)");
  });

  test("ignores system/tool messages and sentences without a signal word", async () => {
    const session: CapturedSession = {
      id: "ses_0000bbbb",
      client: "chatgpt",
      started_at: "2026-10-24T00:00:00.000Z",
      messages: [
        { role: "system", content: "You built everything." },
        { role: "tool", content: "shipped: ok" },
        { role: "user", content: "What is the weather like? It is sunny." },
      ],
    };
    const result = await new HeuristicDistiller().distill(session);
    assert.deepEqual(result.drafts, []);
    assert.equal(result.plan, "heuristic: 0 candidate sentences from 1 messages (simulated)");
  });

  test("folder guess: career before projects before team, else undefined", () => {
    assert.equal(guessFolder("Applied to a backend internship through the recruiter"), "career");
    assert.equal(guessFolder("Merged the hook PR into the repo"), "projects");
    assert.equal(guessFolder("We decided on plain SSE"), "team");
    assert.equal(guessFolder("Prefers TypeScript over Python"), undefined);
    assert.equal(guessFolder("Updated my resume with the server PR"), "career", "career keywords win");
  });
});
