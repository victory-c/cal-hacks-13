import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { FakeJudge } from "./fake.ts";
import type { Question } from "../types/judge.ts";

const questions: Question[] = [
  { id: "keep", type: "noul", text: "Worth keeping hot?" },
  { id: "folder", type: "choice", text: "Which folder?", options: ["career", "projects", "team"] },
  { id: "dupe", type: "choice", text: "New, duplicate, or supersedes?", options: ["add", "merge", "supersede"] },
  { id: "quality", type: "score", text: "How specific is it?", min: 0, max: 10 },
];

describe("FakeJudge", () => {
  test("is deterministic and keyword driven", async () => {
    const judge = new FakeJudge();
    assert.equal(judge.name, "fake");
    const state = "I built the capture hook; this belongs in projects.";
    const a = await judge.ask(state, questions);
    const b = await judge.ask(state, questions);
    assert.deepEqual(a, b);
    assert.deepEqual(a, [
      { id: "keep", type: "noul", p: 0.8 },
      { id: "folder", type: "choice", choice: "projects", p: 0.5 },
      { id: "dupe", type: "choice", choice: "add", p: 0.5 },
      { id: "quality", type: "score", value: 5 },
    ]);
  });

  test("noul is 0.3 without a keyword in state or question, 0.8 when the question text has one", async () => {
    const judge = new FakeJudge();
    const [none] = await judge.ask("the weather is nice", [{ id: "q", type: "noul", text: "Is it relevant?" }]);
    assert.deepEqual(none, { id: "q", type: "noul", p: 0.3 });
    const [hit] = await judge.ask("the weather is nice", [{ id: "q", type: "noul", text: "Does this mention a deadline?" }]);
    assert.deepEqual(hit, { id: "q", type: "noul", p: 0.8 });
  });

  test("custom keywords replace the defaults; matching is case-insensitive", async () => {
    const judge = new FakeJudge({ keywords: ["moss"] });
    const [a, b] = await judge.ask("We BUILT it with MOSS", [
      { id: "a", type: "noul", text: "x" },
      { id: "b", type: "noul", text: "built?" },
    ]);
    assert.equal(a.type === "noul" && a.p, 0.8);
    const only = await judge.ask("We BUILT it", [{ id: "b", type: "noul", text: "built?" }]);
    assert.equal(only[0].type === "noul" && only[0].p, 0.3, "default keywords are gone");
    assert.equal(b.type, "noul");
  });

  test("override wins when it returns an Answer and falls through when it returns undefined", async () => {
    const judge = new FakeJudge({
      override: (q, state) => (q.id === "keep" ? { id: q.id, type: "noul", p: state.includes("secret") ? 0.99 : 0.01 } : undefined),
    });
    const answers = await judge.ask("a secret decided thing", questions);
    assert.deepEqual(answers[0], { id: "keep", type: "noul", p: 0.99 });
    assert.deepEqual(answers[1], { id: "folder", type: "choice", choice: "career", p: 0.5 });
  });
});
