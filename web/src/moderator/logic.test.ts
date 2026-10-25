import assert from "node:assert/strict";
import { test } from "node:test";

import type { Group, ModPrincipal } from "./contract.ts";
import { editedRule, excludedFrom, filterAudit, groupClass, includedGroups, modFeedText, peopleTree, stageDetail } from "./logic.ts";

const groups: Group[] = [
  { id: "deal/stonewall", name: "Project Stonewall", description: "" },
  { id: "market/public", name: "Public market", description: "" },
  { id: "custom/counsel", name: "Counsel", description: "" },
  { id: "custom/vendors", name: "Vendors", description: "" },
];

test("seeded groups keep their colour; new groups take the palette in order", () => {
  assert.equal(groupClass("deal/stonewall", groups), "deal");
  assert.equal(groupClass("custom/counsel", groups), "olive");
  assert.equal(groupClass("custom/vendors", groups), "rose");
  assert.equal(groupClass("inbox", groups), "inboxg");
});

test("included and excluded groups convert both ways, wildcards included", () => {
  assert.deepEqual(includedGroups(["deal/*"], groups), ["market/public", "custom/counsel", "custom/vendors"]);
  assert.deepEqual(excludedFrom(["market/public"], groups), ["deal/stonewall", "custom/counsel", "custom/vendors"]);
});

test("editing task or group cards preserves labels, prose and exclusions for future groups", () => {
  const previous = { task: "old task", exclusions: { groups: ["deal/*", "future/private"], labels: ["taylor-mason"], text: ["pending deals"] } };
  const edited = editedRule("new task", ["market/public", "custom/counsel"], groups, previous);
  assert.deepEqual(edited, { task: "new task", exclusions: { groups: ["deal/*", "future/private", "custom/vendors"], labels: ["taylor-mason"], text: ["pending deals"] } });
  assert.deepEqual(editedRule("no memory", [], groups, previous).exclusions.labels, ["taylor-mason"]);
  assert.ok(!editedRule("explicitly allow the deal", groups.map((g) => g.id), groups, previous).exclusions.groups.includes("deal/*"));
  assert.deepEqual(includedGroups(["deal"], groups), ["market/public", "custom/counsel", "custom/vendors"]);
});

test("people come first, each followed by their agents", () => {
  const ps: ModPrincipal[] = [
    { id: "a1", kind: "agent", name: "A1", creator: "ben", rule: null, fact_ids: [] },
    { id: "wags", kind: "person", name: "Wags", tier: "moderator", rule: null, fact_ids: [] },
    { id: "ben", kind: "person", name: "Ben", tier: "member", rule: null, fact_ids: [] },
  ];
  assert.deepEqual(peopleTree(ps).map((x) => `${x.depth}:${x.p.id}`), ["0:wags", "0:ben", "1:a1"]);
});

test("build stages read in plain words", () => {
  const base = { type: "scope.build" as const, at: "", build_id: "b", principal: "ben" };
  assert.equal(stageDetail({ ...base, stage: "exclusions", counts: { removed: 14 }, groups_removed: ["Project Stonewall"] }), "14 facts outside the selected groups removed: Project Stonewall");
  assert.equal(stageDetail({ ...base, stage: "judged", counts: { yes: 11, no: 0 } }), "11 yes, 0 no");
  assert.equal(stageDetail({ ...base, stage: "done", counts: { facts: 1 } }), "1 fact");
});

test("feed lines: quarantine is an alert, intermediate build stages are silent", () => {
  const name = (id: string) => ({ ben: "Ben Kim" } as Record<string, string>)[id] ?? id;
  const q = modFeedText({ type: "item.quarantined", at: "", item_id: "i", source: "Counsel email", reason: "Contains instructions aimed at an AI" }, name, groups)!;
  assert.equal(q.alert, true);
  assert.match(q.text, /aimed at an AI/);
  assert.equal(modFeedText({ type: "scope.build", at: "", build_id: "b", principal: "ben", stage: "candidates", counts: {} }, name, groups), null);
  assert.equal(modFeedText({ type: "fact.filed", at: "", fact_ids: ["a", "b"], group: "market/public", from: ["Project Stonewall"] }, name, groups)!.text, "Filed 2 facts from Project Stonewall to Public market");
});

test("audit filters by person and group, newest first", () => {
  const entries = [
    { at: "1", principal: "ben", group: "market/public", text: "first" },
    { at: "2", principal: "axe", group: null, text: "second" },
    { at: "3", principal: "ben", group: null, text: "third" },
  ];
  assert.deepEqual(filterAudit(entries, "ben", "").map((e) => e.text), ["third", "first"]);
  assert.deepEqual(filterAudit(entries, "", "market/public").map((e) => e.text), ["first"]);
});
