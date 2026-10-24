import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";

import { DEMO_GRANTS, grantFor, parseFactFile } from "@canon/shared";
import type { Fact } from "@canon/shared";

import { FIXTURES_DIR } from "../seed.ts";
import { KeywordRetriever, stem, tokenize } from "./keyword.ts";

const fact = (id: string, folder: Fact["folder"], statement: string, detail?: string): Fact => ({
  id,
  statement,
  folder,
  tier: "hot",
  jev_keep: 0.8,
  source: { client: "claude-code", session: "ses_0001" },
  updated: "2026-10-23",
  ...(detail ? { detail } : {}),
});

const facts = [
  fact("fct_0001", "career/skills", "Writes production TypeScript on Node 22", "Comfortable with zod and node:test"),
  fact("fct_0002", "career/projects", "Built a Chrome extension that captures ChatGPT sessions"),
  fact("fct_0003", "private/health", "Sleeping 06:00–10:00 during the hackathon; TypeScript dreams"),
  fact("fct_0004", "projects/canon", "Canon's MCP server exposes four tools"),
];

describe("tokenize", () => {
  test("lowercases, drops stopwords and one-char tokens, keeps c++/c#", () => {
    assert.deepEqual([...tokenize("The TypeScript and C++ a C# x")], ["typescript", "c++", "c#"]);
    assert.equal(tokenize("the and of").size, 0);
  });

  test("stems plurals and -ing/-ed so a query meets the stored wording", () => {
    const same = (a: string, b: string) => assert.equal(stem(a), stem(b), `${a} vs ${b}`);
    same("internship", "internships");
    same("session", "sessions");
    same("pipeline", "pipelines");
    same("ship", "shipped");
    same("ship", "shipping");
    same("decide", "decided");
    same("technology", "technologies");
    same("class", "classes");
    same("resume", "resume");
    // Never below 4 characters, and symbols/digits are left alone.
    assert.equal(stem("string"), "string");
    assert.equal(stem("thing"), "thing");
    assert.equal(stem("c++"), "c++");
    assert.equal(stem("node22"), "node22");
    assert.equal(stem("typescript"), "typescript");
    assert.equal(stem("backend"), "backend");
  });
});

describe("KeywordRetriever", () => {
  test("scores by the share of query tokens found, highest first, and respects k", async () => {
    const r = new KeywordRetriever();
    await r.index(facts);
    const all: Fact["folder"][] = ["career", "projects", "team", "private"];
    const hits = await r.search("TypeScript zod", { folders: all, k: 10 });
    assert.deepEqual(
      hits.map((h) => [h.fact.id, h.score]),
      [
        ["fct_0001", 1],
        ["fct_0003", 0.5],
      ],
    );
    assert.equal((await r.search("TypeScript zod", { folders: all, k: 1 })).length, 1);
  });

  test("only returns facts in the granted folders (prefix per segment)", async () => {
    const r = new KeywordRetriever();
    await r.index(facts);
    const hits = await r.search("TypeScript", { folders: ["career"], k: 10 });
    assert.deepEqual(
      hits.map((h) => h.fact.id),
      ["fct_0001"],
    );
    assert.equal((await r.search("TypeScript", { folders: ["careers" as Fact["folder"]], k: 10 })).length, 0);
  });

  test("the folder path is searchable too, and an all-stopword query returns nothing", async () => {
    const r = new KeywordRetriever();
    await r.index(facts);
    const hits = await r.search("canon", { folders: ["projects"], k: 10 });
    assert.deepEqual(
      hits.map((h) => h.fact.id),
      ["fct_0004"],
    );
    assert.deepEqual(await r.search("the of", { folders: ["projects"], k: 10 }), []);
  });

  test("index replaces the previous contents", async () => {
    const r = new KeywordRetriever();
    await r.index(facts);
    await r.index([]);
    assert.deepEqual(await r.search("TypeScript", { folders: ["career"], k: 10 }), []);
  });

  test("the demo task finds the recruiting fact in the shipped fixtures, for chatgpt and claude-code alike", async () => {
    const root = join(FIXTURES_DIR, "facts");
    const files = (await readdir(root, { recursive: true })).filter((n) => n.endsWith(".md"));
    const fixtures = await Promise.all(files.map(async (n) => parseFactFile(await readFile(join(root, n), "utf8"))));
    const r = new KeywordRetriever();
    await r.index(fixtures.filter((f) => f.tier === "hot"));

    const task = "update my resume for a backend internship";
    for (const client of ["chatgpt", "claude-code"]) {
      const hits = await r.search(task, { folders: grantFor(DEMO_GRANTS, client)!.read, k: 20 });
      assert.ok(hits.length > 0, `${client}: no candidates for the demo task`);
      assert.equal(hits[0].fact.id, "fct_5e7091b3", `${client}: the recruiting fact should rank first`);
    }
  });
});
