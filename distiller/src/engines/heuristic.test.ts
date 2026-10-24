import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import type { CapturedSession } from "@canon/shared";
import { HeuristicDistiller, asDay, attribute, guessFolder, isoDayIn, principalName } from "./heuristic.ts";
import { loadFixture } from "../test-helpers.ts";

function world(name: string): CapturedSession {
  return JSON.parse(readFileSync(new URL(`../../fixtures/world/${name}`, import.meta.url), "utf8")) as CapturedSession;
}

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
      assert.equal(d.happened, undefined, "no ISO date in the v1 fixture, so no happened");
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

  test("finance: deal words and deal numbers are signals, names stay on, happened comes off an ISO date", async () => {
    const session: CapturedSession = {
      id: "ses_0000f1a0",
      client: "ingest",
      kind: "chat",
      started_at: "2026-10-21T15:00:00.000Z",
      messages: [
        { role: "user", content: "Dan: I proposed a 9.5x EBITDA multiple for Project Falcon.\nLeo: lunch anyone? the usual place" },
        { role: "user", content: "Dan: We agreed the LOI goes to the Nimbus board by 2026-10-28." },
        { role: "user", content: "Maya: Round the offer to 38.50/sh for NMBL holders." },
        { role: "user", content: "Leo: what's the price on the regional bank basket?" },
        { role: "user", content: "Priya: Diligence kickoff is 2026-13-45 per the calendar invite." },
      ],
    };
    const result = await new HeuristicDistiller().distill(session);
    assert.equal(result.simulated, true);
    assert.deepEqual(
      result.drafts.map((d) => [d.statement, d.happened]),
      [
        ["Dan proposed a 9.5x EBITDA multiple for Project Falcon.", undefined],
        ["Dan's team agreed the LOI goes to the Nimbus board by 2026-10-28.", "2026-10-28"],
        ["Maya: Round the offer to 38.50/sh for NMBL holders.", undefined],
        ["Priya: Diligence kickoff is 2026-13-45 per the calendar invite.", undefined],
      ],
      "code names and tickers verbatim; a question and a line with no signal are skipped; a non-date is not a happened",
    );
    assert.ok(result.drafts.every((d) => d.source.client === "ingest" && d.source.session === "ses_0000f1a0"));
    assert.equal(result.drafts[0].folder, "team", "deal work guesses the team folder");
  });

  test("an AI session's user turns belong to its principal; an email thread's do not; header lines are skipped", async () => {
    const ai: CapturedSession = {
      id: "ses_0000f1a1",
      client: "chatgpt",
      kind: "ai_session",
      principal: "dan",
      started_at: "2026-10-22T02:14:09.000Z",
      messages: [
        { role: "user", content: "I'm thinking we lead at 9.5x for Falcon." },
        { role: "assistant", content: "I'd note that 9.5x implies about $38.48 per share." },
      ],
    };
    const fromAi = await new HeuristicDistiller().distill(ai);
    assert.deepEqual(fromAi.drafts.map((d) => d.statement), ["Dan is thinking we lead at 9.5x for Falcon.", "I'd note that 9.5x implies about $38.48 per share."]);

    const email: CapturedSession = {
      id: "ses_0000f1a2",
      client: "ingest",
      kind: "email",
      principal: "dan",
      external: true,
      started_at: "2026-10-22T16:05:00.000Z",
      messages: [{ role: "user", content: "From: James <j@whitcombehale.example>\nDate: 2026-10-22\nSubject: RE: Project Falcon diligence\n\nI agreed the data room opens once the amendment is signed." }],
    };
    const fromEmail = await new HeuristicDistiller().distill(email);
    assert.deepEqual(fromEmail.drafts.map((d) => d.statement), ["Agreed the data room opens once the amendment is signed."], "no header lines, and never 'Dan agreed' for James's words");
  });

  test("world: Dan's ChatGPT session gives Falcon deal terms in Dan's name, with dates", async () => {
    const result = await new HeuristicDistiller().distill(world("dan-chatgpt-falcon-terms.json"));
    const statements = result.drafts.map((d) => d.statement);
    assert.equal(result.simulated, true);
    assert.ok(result.drafts.length > 0 && result.drafts.length <= 8);
    assert.ok(statements.includes("Dan: Ok round to 38.50/sh."), statements.join("\n"));
    assert.ok(statements.includes("Dan is thinking we lead at 9.5x."), statements.join("\n"));
    assert.ok(statements.some((s) => s.startsWith("Dan's team agreed internally that QoE goes to Ashby & Rowe")), statements.join("\n"));
    assert.ok(result.drafts.some((d) => d.happened === "2026-10-29"), "the board date is read off the text");
    assert.ok(result.drafts.every((d) => d.source.url?.startsWith("https://chatgpt.com/c/")));
    assert.ok(statements.every((s) => !s.endsWith("?") && !/^Dan: Whats/.test(s)), "questions are not facts");
  });

  test("world: the memo keeps NMBL and Corvane verbatim and skips its header lines", async () => {
    const result = await new HeuristicDistiller().distill(world("falcon-process-memo.json"));
    const statements = result.drafts.map((d) => d.statement);
    assert.ok(statements.some((s) => s.includes("$38.50 per NMBL share")), statements.join("\n"));
    assert.ok(statements.some((s) => s.includes("Corvane")), statements.join("\n"));
    assert.ok(statements.every((s) => !/^Dan: (?:To|From|Cc|Date|Re):/.test(s)), statements.join("\n"));
    assert.ok(statements.every((s) => !s.startsWith("Dan: - ")), "list markers are stripped");
    assert.ok(result.drafts.some((d) => d.happened === "2026-10-28"));
  });

  test("world: the chat's indirect reference survives word for word, attributed to Dan", async () => {
    const result = await new HeuristicDistiller().distill(world("hl-floor-chat-week.json"));
    assert.ok(result.drafts.some((d) => d.statement === "Dan: Can't, the logistics thing is eating my whole week, board stuff due by the 29th."), result.drafts.map((d) => d.statement).join("\n"));
    const attestations = result.drafts.find((d) => d.statement.startsWith("Maya: Deadline"));
    assert.equal(attestations?.happened, "2026-10-23");
  });

  test("world: the planted instruction in the lawyers' email never becomes a draft", async () => {
    const result = await new HeuristicDistiller().distill(world("outside-counsel-email.json"));
    assert.match(result.plan ?? "", /1 paragraph left out as instructions aimed at an AI \(simulated\)$/);
    for (const d of result.drafts) {
      assert.doesNotMatch(d.statement, /public|ignore|priya@|research@|compliance/i, d.statement);
      assert.doesNotMatch(d.statement, /^Dan\b/, "an email thread is not Dan's own words");
    }
  });

  test("attribute: third person with the speaker's name, or the v1 style with no speaker", () => {
    assert.equal(attribute("I proposed 9.5x", "Dan"), "Dan proposed 9.5x");
    assert.equal(attribute("I have sent the LOI", "Dan"), "Dan has sent the LOI");
    assert.equal(attribute("I've sent the LOI", "Dan"), "Dan has sent the LOI");
    assert.equal(attribute("I'm on the Falcon board call", "Dan"), "Dan is on the Falcon board call");
    assert.equal(attribute("We agreed to 45 days", "Dan"), "Dan's team agreed to 45 days");
    assert.equal(attribute("board meets 2026-10-29", "Dan"), "Dan: Board meets 2026-10-29");
    assert.equal(attribute("Dan sent it", "Dan"), "Dan sent it", "no double name");
    assert.equal(attribute("We decided to ship it."), "Decided to ship it.");
    assert.equal(attribute("I have decided"), "Decided");
  });

  test("dates: asDay wants a real YYYY-MM-DD; isoDayIn finds the first real one", () => {
    assert.equal(asDay("2026-10-28"), "2026-10-28");
    assert.equal(asDay(" 2026-10-28 "), "2026-10-28");
    assert.equal(asDay("2026-02-30"), undefined);
    assert.equal(asDay("2026-10-28T00:00:00Z"), undefined);
    assert.equal(asDay("Oct 28"), undefined);
    assert.equal(asDay(null), undefined);
    assert.equal(isoDayIn("LOI by 2026-10-28, board 2026-10-29"), "2026-10-28");
    assert.equal(isoDayIn("bad 2026-99-01 then 2026-10-29"), "2026-10-29");
    assert.equal(isoDayIn("captured 2026-10-24T03:02:11.000Z"), "2026-10-24");
    assert.equal(isoDayIn("ref 12026-10-28"), undefined);
    assert.equal(isoDayIn("by the 29th"), undefined);
  });

  test("principalName: first-name ids only", () => {
    assert.equal(principalName("dan"), "Dan");
    assert.equal(principalName("agt_research_1"), undefined);
    assert.equal(principalName(undefined), undefined);
  });

  test("folder guess: career before projects before team, else undefined", () => {
    assert.equal(guessFolder("Applied to a backend internship through the recruiter"), "career");
    assert.equal(guessFolder("Merged the hook PR into the repo"), "projects");
    assert.equal(guessFolder("We decided on plain SSE"), "team");
    assert.equal(guessFolder("Dan proposed a 9.5x EBITDA multiple for Project Falcon"), "team");
    assert.equal(guessFolder("Prefers TypeScript over Python"), undefined);
    assert.equal(guessFolder("Updated my resume with the server PR"), "career", "career keywords win");
  });
});
