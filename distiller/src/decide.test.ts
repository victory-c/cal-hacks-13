import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { FACT_ID_RE, FakeJudge, INBOX, THRESHOLDS, validateFact } from "@canon/shared";
import type { Answer, DraftFact, Judge, Question } from "@canon/shared";
import { decideFacts } from "./decide.ts";
import { fakeFact, quiet } from "./test-helpers.ts";

const source = { client: "claude-code", session: "ses_b2f1c9a4" };
const drafts: DraftFact[] = [
  { statement: "Built the Claude Code capture hook", folder: "projects", source },
  { statement: "The weather was nice", source },
  { statement: "Prefers TypeScript in production", source, detail: "Said during the hook session." },
  { statement: "Shipped the capture hook in PR #7 and merged to main", folder: "career/projects", source },
];
const existing = [fakeFact("fct_aaaa0001", "Building the Claude Code capture hook"), fakeFact("fct_aaaa0002", "Prefers Python", { folder: "private" })];

/** A judge that scripts answers by question id and counts calls. */
function scripted(script: Record<string, Partial<Answer>>): Judge & { calls: Array<{ state: string; questions: Question[] }> } {
  const calls: Array<{ state: string; questions: Question[] }> = [];
  const fake = new FakeJudge({
    override: (q) => {
      const s = script[q.id];
      if (!s) return undefined;
      if (q.type === "noul") return { id: q.id, type: "noul", p: 0.5, ...s } as Answer;
      if (q.type === "choice") return { id: q.id, type: "choice", choice: q.options[0], p: 0.9, ...s } as Answer;
      return undefined;
    },
  });
  return {
    name: "fake",
    calls,
    async ask(state, questions) {
      calls.push({ state, questions });
      return fake.ask(state, questions);
    },
  };
}

describe("decideFacts", () => {
  test("asks the judge exactly once for the whole batch, with every draft's four questions", async () => {
    const judge = scripted({});
    const { result } = await quiet(() => decideFacts(drafts, existing, judge));
    assert.equal(judge.calls.length, 1, "one ask() for the batch (CLAUDE.md rule)");
    const { state, questions } = judge.calls[0];
    assert.equal(questions.length, drafts.length * 4);
    assert.deepEqual(
      questions.slice(0, 4).map((q) => q.id),
      ["keep:0", "folder:0", "dupe:0", "which:0"],
    );
    const folderQ = questions.find((q) => q.id === "folder:3");
    assert.ok(folderQ?.type === "choice" && folderQ.options.includes("career/projects"), "a suggested subfolder is an option");
    const folder0 = questions.find((q) => q.id === "folder:0");
    assert.ok(folder0?.type === "choice" && folder0.options.filter((o) => o === "projects").length === 1, "a bare top folder is not duplicated");
    const whichQ = questions.find((q) => q.id === "which:1");
    assert.ok(whichQ?.type === "choice");
    assert.deepEqual(whichQ.options, ["fct_aaaa0001", "fct_aaaa0002", "none"]);
    const parsed = JSON.parse(state) as { drafts: unknown[]; existing_hot_facts: Array<{ id: string; statement: string }> };
    assert.equal(parsed.drafts.length, 4);
    assert.deepEqual(parsed.existing_hot_facts[0], { id: "fct_aaaa0001", statement: "Building the Claude Code capture hook" });
    assert.equal(result.length, 4);
  });

  test("hot, cold, inbox and supersede paths follow THRESHOLDS", async () => {
    const judge = scripted({
      "keep:0": { p: 0.95 },
      "folder:0": { choice: "projects", p: 0.9 },
      "dupe:0": { choice: "supersedes" },
      "which:0": { choice: "fct_aaaa0001" },

      "keep:1": { p: 0.2 },
      "folder:1": { choice: "team", p: 0.9 },
      "dupe:1": { choice: "new" },
      "which:1": { choice: "none" },

      "keep:2": { p: 0.8 },
      "folder:2": { choice: "career", p: 0.2 }, // below FOLDER_CONFIDENT → inbox
      "dupe:2": { choice: "duplicate" },
      "which:2": { choice: "fct_aaaa0002" },

      "keep:3": { p: THRESHOLDS.KEEP_HOT }, // exactly the threshold is not "> KEEP_HOT"
      "folder:3": { choice: "career/projects", p: THRESHOLDS.FOLDER_CONFIDENT },
      "dupe:3": { choice: "supersedes" },
      "which:3": { choice: "none" }, // supersedes nothing → plain add
    });
    const { result } = await quiet(() => decideFacts(drafts, existing, judge));
    const [a, b, c, d] = result;

    assert.equal(a.decision.tier, "hot");
    assert.equal(a.decision.action, "supersede");
    assert.equal(a.decision.supersedes, "fct_aaaa0001");
    assert.equal(a.fact.supersedes, "fct_aaaa0001");
    assert.equal(a.fact.folder, "projects");
    assert.equal(a.fact.jev_keep, 0.95);

    assert.equal(b.decision.tier, "cold");
    assert.equal(b.fact.tier, "cold");
    assert.equal(b.decision.action, "add");
    assert.equal(b.fact.supersedes, undefined);
    assert.equal(b.fact.folder, "team");

    assert.equal(c.decision.folder, INBOX);
    assert.equal(c.fact.folder, INBOX);
    assert.equal(c.decision.folder_p, 0.2);
    assert.equal(c.decision.action, "merge");
    assert.equal(c.decision.supersedes, "fct_aaaa0002");
    assert.equal(c.fact.detail, "Said during the hook session.");

    assert.equal(d.decision.tier, "cold");
    assert.equal(d.fact.folder, "career/projects");
    assert.equal(d.decision.action, "add", "supersedes + none → add");
    assert.equal(d.decision.supersedes, undefined);

    for (const { fact, decision } of result) {
      assert.match(fact.id, FACT_ID_RE);
      assert.match(fact.updated, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(decision.judge, "fake");
      assert.deepEqual(fact.source, source);
      const v = validateFact(fact);
      assert.ok(v.ok, `fact is valid per the contract: ${v.ok ? "" : v.errors.join("; ")}`);
    }
    assert.equal(new Set(result.map((r) => r.fact.id)).size, 4, "ids are unique");
  });

  test("a draft that repeats an existing hot fact word for word merges into it, whatever the judge says", async () => {
    // The fake judge's default for a choice is options[0] = "new" / "none": exactly the answer
    // that used to file a second copy of every fact on a re-distill.
    const judge = scripted({ "dupe:0": { choice: "new" }, "which:0": { choice: "none" } });
    const repeat: DraftFact = { statement: "  building the claude code CAPTURE hook!  ", folder: "projects", source };
    const { result } = await quiet(() => decideFacts([repeat, drafts[1]], existing, judge));
    assert.equal(result[0].decision.action, "merge");
    assert.equal(result[0].decision.supersedes, "fct_aaaa0001");
    assert.equal(result[0].fact.supersedes, "fct_aaaa0001");
    assert.equal(result[0].fact.statement, repeat.statement, "the statement itself is not rewritten");
    assert.equal(result[1].decision.action, "add", "a different statement still follows the judge");
    assert.equal(judge.calls.length, 1);
    assert.equal(judge.calls[0].questions.length, 8, "tier and folder are still the judge's call, so every question is still asked");
  });

  test("an exact duplicate of a fact outside the 40 the judge sees is still merged", async () => {
    const many = Array.from({ length: 60 }, (_, i) => fakeFact(`fct_${String(i).padStart(8, "0")}`, `fact ${i}`));
    const judge = scripted({});
    const { result } = await quiet(() => decideFacts([{ statement: "Fact 3", source }, { statement: "Fact 59", source }], many, judge));
    assert.equal(result[0].decision.action, "merge");
    assert.equal(result[0].decision.supersedes, "fct_00000003", "fct_00000003 is not among the 40 most recent, but it is in the store");
    assert.equal(result[1].decision.supersedes, "fct_00000059");
  });

  test("a 'which' answer that names an unknown fact id is treated as none", async () => {
    const judge = scripted({ "dupe:0": { choice: "supersedes" }, "which:0": { choice: "fct_dead0000" } });
    const { result } = await quiet(() => decideFacts(drafts.slice(0, 1), existing, judge));
    assert.equal(result[0].decision.action, "add");
    assert.equal(result[0].fact.supersedes, undefined);
  });

  test("missing answers fall back to cold + inbox instead of throwing", async () => {
    const judge: Judge = { name: "fake", ask: async () => [] };
    const result = await decideFacts(drafts.slice(0, 1), [], judge);
    assert.equal(result[0].decision.tier, "cold");
    assert.equal(result[0].decision.folder, INBOX);
    assert.equal(result[0].decision.action, "add");
    assert.equal(result[0].decision.keep_p, 0.5);
  });

  test("an empty batch never calls the judge; the existing list is capped at 40", async () => {
    const judge = scripted({});
    assert.deepEqual(await decideFacts([], existing, judge), []);
    assert.equal(judge.calls.length, 0);

    const many = Array.from({ length: 60 }, (_, i) => fakeFact(`fct_${String(i).padStart(8, "0")}`, `fact ${i}`));
    await quiet(() => decideFacts(drafts.slice(0, 1), many, judge));
    const whichQ = judge.calls[0].questions.find((q) => q.id === "which:0");
    assert.ok(whichQ?.type === "choice");
    assert.equal(whichQ.options.length, 41, "40 most recent ids + none");
    assert.equal(whichQ.options[0], "fct_00000020");
  });

  test("with the plain FakeJudge the fixture-like drafts come out deterministic", async () => {
    const judge = new FakeJudge();
    const { result: a } = await quiet(() => decideFacts(drafts, [], judge));
    const { result: b } = await quiet(() => decideFacts(drafts, [], judge));
    assert.deepEqual(a.map((r) => r.decision), b.map((r) => r.decision));
    assert.ok(a.every((r) => r.decision.action === "add"), "no existing facts → nothing to merge or supersede");
  });
});
