import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { factPath, parseFactFile, serializeFactFile, validateFact } from "./fact-file.ts";
import type { Fact } from "./types/fact.ts";

const base: Fact = {
  id: "fct_7f3a",
  statement: "Built Canon's live capture hook for Claude Code sessions",
  folder: "career/projects",
  tier: "hot",
  jev_keep: 0.91,
  source: { client: "claude-code", session: "ses_3b9e", pr: "https://github.com/victory-c/canon/pull/12" },
  supersedes: "fct_12aa",
  updated: "2026-10-24",
  detail: "First paragraph.\n\nSecond paragraph with `code` and a list:\n- one\n- two\n\n    indented code line",
};

describe("serializeFactFile", () => {
  test("writes the CLAUDE.md shape with a flow-mapping source", () => {
    const text = serializeFactFile(base);
    assert.equal(
      text,
      [
        "---",
        "id: fct_7f3a",
        "statement: Built Canon's live capture hook for Claude Code sessions",
        "folder: career/projects",
        "tier: hot",
        "jev_keep: 0.91",
        "source: { client: claude-code, session: ses_3b9e, pr: https://github.com/victory-c/canon/pull/12 }",
        "supersedes: fct_12aa",
        "updated: 2026-10-24",
        "---",
        base.detail,
        "",
      ].join("\n"),
    );
  });

  test("omits undefined optionals and ends right after the frontmatter when there is no detail", () => {
    const { supersedes: _s, detail: _d, ...rest } = base;
    const text = serializeFactFile({ ...rest, source: { client: "chatgpt", session: "ses_0001" } });
    assert.ok(!text.includes("supersedes"));
    assert.ok(text.endsWith("updated: 2026-10-24\n---\n"));
    assert.equal(text.split("\n").filter((l) => l.startsWith("source:"))[0], "source: { client: chatgpt, session: ses_0001 }");
  });

  test("quotes statements that YAML would misread", () => {
    const text = serializeFactFile({ ...base, statement: "Decided: use plain SSE, not SpacetimeDB # for now" });
    assert.ok(text.includes('statement: "Decided: use plain SSE, not SpacetimeDB # for now"'));
    for (const s of ["42", "true", "- bullet", " padded ", "ends with colon:", "", "[x]"]) {
      if (s.trim() === "") continue; // empty statement is invalid, tested below
      const line = serializeFactFile({ ...base, statement: s }).split("\n")[2];
      assert.equal(line, `statement: ${JSON.stringify(s)}`, `expected quoting for ${JSON.stringify(s)}`);
    }
  });

  test("refuses an invalid fact instead of writing garbage", () => {
    assert.throws(() => serializeFactFile({ ...base, jev_keep: 1.5 }), /Cannot serialize fact.*jev_keep/);
  });
});

describe("parseFactFile", () => {
  test("serialize → parse roundtrips exactly", () => {
    assert.deepEqual(parseFactFile(serializeFactFile(base)), base);
  });

  test("roundtrips quoting edge cases exactly", () => {
    const cases = [
      "Decided: use plain SSE, not SpacetimeDB # for now",
      '"Quoted" at the start, with a \\ backslash and tab\tinside',
      "42",
      "yes",
      " padded ",
      "- looks like a list item",
      "ends with colon:",
      "it's got an apostrophe and emoji 🎯",
    ];
    for (const statement of cases) {
      const fact: Fact = { ...base, statement, source: { client: "claude-code", session: "ses_1", url: "https://x.test/?a=1,2&b={c}" } };
      assert.deepEqual(parseFactFile(serializeFactFile(fact)), fact, `roundtrip failed for ${JSON.stringify(statement)}`);
    }
  });

  test("reads the block form of source and tolerates comments, blank lines and CRLF", () => {
    const text = [
      "---",
      "# written by hand in Obsidian",
      "id: fct_0001",
      "statement: Prefers TypeScript over Python for backend work",
      "",
      "folder: career",
      "tier: cold",
      "jev_keep: 0.4",
      "source:",
      "  client: chatgpt",
      "  session: 2026-10-24T03:12",
      "  url: 'https://chatgpt.com/c/abc'",
      "updated: 2026-10-24",
      "---",
      "",
      "Some detail.",
      "",
    ].join("\r\n");
    assert.deepEqual(parseFactFile(text), {
      id: "fct_0001",
      statement: "Prefers TypeScript over Python for backend work",
      folder: "career",
      tier: "cold",
      jev_keep: 0.4,
      source: { client: "chatgpt", session: "2026-10-24T03:12", url: "https://chatgpt.com/c/abc" },
      updated: "2026-10-24",
      detail: "Some detail.",
    });
  });

  test("normalizes the detail body: leading blank lines and trailing whitespace go, inner blank lines stay", () => {
    const text = `${serializeFactFile({ ...base, detail: undefined })}\n\nLine one.\n\n\nLine four.  \n\n\n`;
    assert.equal(parseFactFile(text).detail, "Line one.\n\n\nLine four.");
  });

  test("ignores unknown frontmatter keys", () => {
    const text = serializeFactFile(base).replace("tier: hot", "tier: hot\naliases: []\ntags: canon");
    assert.throws(() => parseFactFile(text), /lists are not part of the fact file format/);
    const ok = serializeFactFile(base).replace("tier: hot", "tier: hot\ntags: canon");
    assert.deepEqual(parseFactFile(ok), base);
  });

  test("fails loudly on malformed files", () => {
    assert.throws(() => parseFactFile("id: fct_1\n"), /must start with a "---"/);
    assert.throws(() => parseFactFile("---\nid: fct_1\n"), /no closing "---"/);
    assert.throws(() => parseFactFile("---\nid fct_1\n---\n"), /line 2: expected "key: value"/);
    assert.throws(() => parseFactFile('---\nstatement: "unterminated\n---\n'), /line 2: unterminated double-quoted string/);
    assert.throws(() => parseFactFile(serializeFactFile(base).replace("tier: hot", "tier: warm")), /Invalid fact file: tier must be hot\|cold/);
    assert.throws(() => parseFactFile(serializeFactFile(base).replace("folder: career/projects", "folder: careers")), /folder must be/);
  });
});

describe("validateFact", () => {
  test("accepts every folder shape from the contract", () => {
    for (const folder of ["career", "projects/canon", "private/health/sleep", "inbox"]) {
      assert.equal(validateFact({ ...base, folder }).ok, true, folder);
    }
  });

  test("collects every error at once", () => {
    const r = validateFact({
      id: "fact_1",
      statement: "",
      folder: "careers",
      tier: "warm",
      jev_keep: "0.9",
      source: { client: "", session: 7 },
      supersedes: "nope",
      updated: "24/10/2026",
      detail: 5,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    const fields = ["id", "statement", "folder", "tier", "jev_keep", "source.client", "source.session", "supersedes", "updated", "detail"];
    for (const f of fields) assert.ok(r.errors.some((e) => e.startsWith(`${f} `)), `missing error for ${f}: ${r.errors.join(" | ")}`);
    assert.equal(r.errors.length, fields.length);
  });

  test("rejects path tricks in folders and non-objects", () => {
    for (const folder of ["career/", "career//x", "career/../private", "career/.", "team/with space", "Career"]) {
      assert.equal(validateFact({ ...base, folder }).ok, false, folder);
    }
    assert.deepEqual(validateFact(null), { ok: false, errors: ["fact must be an object (got null)"] });
    assert.equal(validateFact({ ...base, source: "claude-code" }).ok, false);
  });

  test("returns a clean fact: known keys only, optionals only when set, detail normalized", () => {
    const r = validateFact({ ...base, supersedes: undefined, detail: "\n\n  body  \n\n", extra: "dropped" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const { supersedes: _s, ...expected } = base;
    assert.deepEqual(r.fact, { ...expected, detail: "  body" });
    assert.ok(!("supersedes" in r.fact), "undefined optionals are not present as keys");
    assert.ok(!("extra" in r.fact));
  });
});

test("factPath is facts/<folder>/<id>.md", () => {
  assert.equal(factPath(base), "facts/career/projects/fct_7f3a.md");
  assert.equal(factPath({ id: "fct_1", folder: "inbox" }), "facts/inbox/fct_1.md");
});
