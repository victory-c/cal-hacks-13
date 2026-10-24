import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Deal, ListsResponse } from "@canon/shared";
import { UNLABELED, codeWall, dealNames, labelOf, raiseAll, raiseWall } from "./walls.ts";
import type { Label } from "./walls.ts";

const falcon: Deal = {
  id: "deal_falcon",
  code_name: "Project Falcon",
  aliases: ["NMBL"],
  companies: ["Nimbus Logistics"],
  status: "confidential",
  status_changed_at: "2026-10-20T09:00:00Z",
};
const osprey: Deal = { id: "deal_osprey", code_name: "Project Osprey", aliases: [], companies: ["Harrow Rail"], status: "confidential", status_changed_at: "2026-10-21T09:00:00Z" };
const lists: ListsResponse = {
  restricted: [
    { company: "Nimbus Logistics", ticker: "NMBL", added_at: "2026-10-20T09:00:00Z" },
    { company: "Acme Freight", ticker: "ACMF", added_at: "2026-10-22T09:00:00Z" },
  ],
  watch: [{ company: "Corvid Freight", ticker: "CRVD", added_at: "2026-10-21T09:00:00Z" }],
};

describe("codeWall", () => {
  test("code name, its short form, aliases and companies match, case-insensitively", () => {
    assert.deepEqual(dealNames(falcon), ["Project Falcon", "Falcon", "NMBL", "Nimbus Logistics"]);
    for (const text of ["Notes on Project Falcon", "the falcon numbers", "NMBL rose", "nmbl rose", "NIMBUS  LOGISTICS\nboard deck", "Falcon's model"]) {
      const hit = codeWall(text, [falcon]);
      assert.deepEqual(hit.deals, ["deal_falcon"], text);
      assert.match(hit.reason, /^code rule: .* → deal_falcon$/, text);
    }
    assert.deepEqual(codeWall("Project Falcon and Nimbus Logistics", [falcon]).names, ["Project Falcon", "Falcon", "Nimbus Logistics"]);
  });

  test("only on word boundaries", () => {
    for (const text of ["falconry weekend", "Nimbus Logisticsx", "the NMBLX fund", "", "public freight news"]) {
      const hit = codeWall(text, [falcon], lists);
      assert.deepEqual(hit.deals, [], text);
      assert.deepEqual(hit.listed, [], text);
      assert.equal(hit.reason, "", text);
    }
  });

  test("two deals named are both returned, in deal-list order", () => {
    const hit = codeWall("Harrow Rail may bid against Falcon", [falcon, osprey]);
    assert.deepEqual(hit.deals, ["deal_falcon", "deal_osprey"]);
    assert.equal(hit.reason, 'code rule: "Falcon" → deal_falcon; "Harrow Rail" → deal_osprey');
  });

  test("a listed company maps to its deal; one with no deal is reported as listed; watch names stay out of the reason", () => {
    assert.deepEqual(codeWall("buy NMBL", [falcon], lists).deals, ["deal_falcon"]);
    const unmapped = codeWall("Acme Freight and corvid freight both called", [falcon], lists);
    assert.deepEqual(unmapped.deals, []);
    assert.deepEqual(unmapped.listed, [
      { company: "Acme Freight", list: "restricted" },
      { company: "Corvid Freight", list: "watch" },
    ]);
    assert.equal(unmapped.reason, 'code rule: restricted-list company "Acme Freight"; a watch-list name');
    assert.ok(!unmapped.reason.includes("Corvid"), "the watch list is secret");
  });

  test("list tickers match case-sensitively; with no deal list a restricted company still shows up", () => {
    assert.deepEqual(codeWall("acmf is up", [], lists).listed, []);
    assert.deepEqual(codeWall("ACMF is up", [], lists).listed, [{ company: "Acme Freight", list: "restricted" }]);
    assert.deepEqual(codeWall("Nimbus Logistics guidance", [], lists).listed, [{ company: "Nimbus Logistics", list: "restricted" }]);
  });

  test("regex characters in names are literal", () => {
    const odd: Deal = { ...falcon, id: "deal_odd", code_name: "Project A+B (2026)", aliases: ["C.D."], companies: [] };
    assert.deepEqual(codeWall("about A+B (2026) today", [odd]).deals, ["deal_odd"]);
    assert.deepEqual(codeWall("about AAB 2026 today", [odd]).deals, []);
    assert.deepEqual(codeWall("CxD", [odd]).deals, []);
  });
});

describe("raiseWall", () => {
  const labels: Label[] = ["public", "deal_falcon", "deal_osprey", UNLABELED];
  const rank = (l: Label) => (l === "public" ? 0 : l === UNLABELED ? 2 : 1);

  test("public < any deal < unlabeled; it never lowers", () => {
    assert.deepEqual(raiseWall("public", "deal_falcon"), { wall: "deal_falcon" });
    assert.deepEqual(raiseWall("deal_falcon", "public"), { wall: "deal_falcon" });
    assert.deepEqual(raiseWall("deal_falcon", "deal_falcon"), { wall: "deal_falcon" });
    assert.deepEqual(raiseWall(UNLABELED, "public"), { wall: UNLABELED });
    assert.deepEqual(raiseWall("public", UNLABELED), { wall: UNLABELED });
    for (const a of labels) {
      for (const b of labels) {
        const r = raiseWall(a, b);
        assert.ok(rank(r.wall) >= rank(a) && rank(r.wall) >= rank(b), `${a} + ${b} → ${r.wall}`);
        assert.deepEqual(raiseWall(b, a).wall, r.wall, "order does not matter");
      }
    }
  });

  test("two different deals are a conflict and meet at unlabeled", () => {
    assert.deepEqual(raiseWall("deal_falcon", "deal_osprey"), { wall: UNLABELED, conflict: ["deal_falcon", "deal_osprey"] });
    const all = raiseAll("public", ["deal_falcon", "public", "deal_osprey", "deal_falcon"]);
    assert.equal(all.wall, UNLABELED);
    assert.deepEqual(all.conflict, ["deal_falcon", "deal_osprey"], "the first conflict is kept");
    assert.deepEqual(raiseAll("public", []), { wall: "public" });
  });

  test("labelOf: a missing or malformed wall is unlabeled", () => {
    assert.equal(labelOf("public"), "public");
    assert.equal(labelOf("deal_falcon"), "deal_falcon");
    assert.equal(labelOf(undefined), UNLABELED);
    assert.equal(labelOf("Deal_Falcon"), UNLABELED);
    assert.equal(labelOf("secret"), UNLABELED);
  });
});
