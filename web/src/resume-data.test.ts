import assert from "node:assert/strict";
import { test } from "node:test";

import type { Fact } from "@canon/shared";

import { groupCareerFacts, resumeMarkdown, sessionUrl, titleCase } from "./resume-data.ts";

function fact(id: string, folder: Fact["folder"], statement: string, over: Partial<Fact> = {}): Fact {
  return { id, statement, folder, tier: "hot", jev_keep: 0.9, source: { client: "claude-code", session: "ses_0000abcd" }, updated: "2026-10-24", ...over };
}

const facts: Fact[] = [
  fact("fct_0001", "career/skills", "TypeScript, Node, esbuild"),
  fact("fct_0002", "career/projects", "Built Canon's live dashboard", { updated: "2026-10-25" }),
  fact("fct_0003", "career/projects", "Shipped the Claude Code capture hook", { updated: "2026-10-23", source: { client: "chatgpt", session: "ses_0000ffff" } }),
  fact("fct_0004", "career", "Targeting platform roles"),
  fact("fct_0005", "projects/canon", "Not a career fact"),
  fact("fct_0006", "career/skills", "Cold fact, must be skipped", { tier: "cold" }),
];

test("groupCareerFacts: career only, hot only, known sections first, newest first inside", () => {
  const groups = groupCareerFacts(facts);
  assert.deepEqual(
    groups.map((g) => g.key),
    ["projects", "skills", "general"],
  );
  assert.deepEqual(
    groups[0]?.facts.map((f) => f.id),
    ["fct_0002", "fct_0003"],
  );
  assert.equal(groups[1]?.facts.length, 1);
  assert.equal(groups[2]?.title, "General");
});

test("sessionUrl uses the contract route", () => {
  assert.equal(sessionUrl("http://localhost:4100", "ses_0000abcd"), "http://localhost:4100/api/sessions/ses_0000abcd");
});

test("resumeMarkdown names every line's client and session, with no token-gated link", () => {
  const md = resumeMarkdown(groupCareerFacts(facts));
  assert.match(md, /^# Resume\n/);
  assert.match(md, /## Projects\n\n- Built Canon's live dashboard \(claude-code · ses_0000abcd\)/);
  assert.match(md, /\(chatgpt · ses_0000ffff\)/);
  // GET /api/sessions/:id needs a bearer token, so a link there would 401 for whoever pastes this.
  assert.ok(!md.includes("/api/sessions/"));
  assert.ok(!md.includes("Not a career fact"));
  assert.ok(md.endsWith("\n"));
});

test("titleCase", () => {
  assert.equal(titleCase("work-history"), "Work history");
  assert.equal(titleCase("skills/typescript"), "Skills / typescript");
  assert.equal(titleCase("general"), "General");
});
