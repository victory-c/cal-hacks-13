import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Group } from "@canon/shared";
import { aliasGroup, filingGroups, foreignName, itemText, namesWord, startsWordIn } from "./groups.ts";

// An invented firm, so these unit tests say nothing about the demo world's answers.
const GROUPS: Group[] = [
  { id: "deal/heron", description: "Project Heron: a confidential acquisition of Acme Rail.", aliases: ["Project Heron", "Heron", "Acme Rail", "ACMR"] },
  { id: "desk/rates", description: "The rates desk's book.", aliases: ["Basin Power", "BSNP"] },
  { id: "market/public", description: "Public news.", aliases: [] },
];

describe("engine group helpers", () => {
  test("filingGroups keeps well-formed groups once and never the inbox", () => {
    const raw = [
      ...GROUPS,
      { id: "inbox", description: "x" },
      { id: "inbox/later", description: "x" },
      { id: "Deal Heron", description: "x" },
      { id: "deal/heron", description: "a repeat", aliases: ["Osprey"] },
      { id: "firm/ops", description: "Ops.", aliases: ["", "  ", 7, "Front Desk"] },
      null,
      { description: "no id" },
    ] as unknown as Group[];
    const out = filingGroups(raw);
    assert.deepEqual(
      out.map((g) => g.id),
      ["deal/heron", "desk/rates", "market/public", "firm/ops"],
    );
    assert.deepEqual(out[0].aliases, ["Project Heron", "Heron", "Acme Rail", "ACMR"], "the first deal/heron wins");
    assert.deepEqual(out[3].aliases, ["Front Desk"], "blank and non-string aliases are dropped");
    assert.deepEqual(filingGroups(undefined), []);
  });

  test("namesWord matches whole words and phrases in any case; startsWordIn matches word starts", () => {
    assert.ok(namesWord("Sam priced ACMR at 8x", "ACMR"));
    assert.ok(namesWord("the project heron LOI", "Project Heron"));
    assert.ok(namesWord("filed under deal/heron.", "deal/heron"));
    assert.ok(namesWord("Heron's board", "Heron"));
    assert.ok(!namesWord("ACMRX rallied", "ACMR"), "a longer ticker is not the alias");
    assert.ok(!namesWord("herons nest", "Heron"));
    assert.ok(!namesWord("anything", "  "));
    assert.ok(startsWordIn("Q3 2026 markets", "market"));
    assert.ok(startsWordIn("Q3 2026 markets", "q3"));
    assert.ok(!startsWordIn("supermarket", "market"), "the middle of a word is not a word start");
    assert.ok(!startsWordIn("x", ""));
  });

  test("aliasGroup: one group's names → that group; none or two groups → no suggestion", () => {
    assert.equal(aliasGroup("Sam proposed 8x EBITDA for Project Heron", GROUPS), "deal/heron");
    assert.equal(aliasGroup("Sam: acme rail board meets Friday", GROUPS), "deal/heron", "any case");
    assert.equal(aliasGroup("Lee trimmed BSNP into the print", GROUPS), "desk/rates");
    assert.equal(aliasGroup("Lee trimmed BSNP and ACMR into the print", GROUPS), undefined, "two groups' names: unsure");
    assert.equal(aliasGroup("Sam: the rail thing is eating my week", GROUPS), undefined, "a hint names no alias");
    assert.equal(aliasGroup("Public news on rates", GROUPS), undefined, "a group id is not an alias");
    assert.equal(aliasGroup("Project Heron", []), undefined, "no list, no suggestion");
  });

  test("foreignName finds a group id or alias the draft names and the item never does", () => {
    const item = "Acme Rail reported Q3 results. ACMR fell 4%.";
    assert.equal(foreignName("Acme Rail reported Q3 results", item, GROUPS), undefined);
    assert.equal(foreignName("Acme Rail is the target of Project Heron", item, GROUPS), "Project Heron");
    assert.equal(foreignName("ACMR fell 4%\nFiled under deal/heron", item, GROUPS), "deal/heron");
    assert.equal(foreignName("Lee is long BSNP", item, GROUPS), "BSNP");
    assert.equal(foreignName("Project Heron moved", "Update on project heron", GROUPS), undefined, "case does not matter");
    assert.equal(foreignName("Sam priced Project Heron at 8x", "sanity check on heron terms", GROUPS), undefined, "a longer form of a name the item says is not new");
    assert.equal(foreignName("Sam priced Project Heron at 8x", "sanity check on rail terms", GROUPS), "Project Heron", "unless the item says neither");
    assert.equal(foreignName("Filed under deal/heron", "sanity check on heron terms", GROUPS), "deal/heron", "a group id is never a longer form of an alias");
  });

  test("itemText is the title and every message", () => {
    assert.equal(itemText({ title: "T", messages: [{ content: "a" }, { content: "b" }] }), "T\na\nb");
    assert.equal(itemText({ messages: [{ content: "a" }] }), "\na");
  });
});
