import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Group } from "@canon/shared";
import { aliasHits, foldText, groupNames, matchForms } from "./groups.ts";

const falcon: Group = { id: "deal/falcon", description: "Project Falcon", aliases: ["Project Falcon", "Nimbus Logistics", "NMBL"] };
const osprey: Group = { id: "deal/osprey", description: "Project Osprey", aliases: ["Project Osprey", "Harrow Rail"] };
const trading: Group = { id: "desk/trading", description: "The trading desk", aliases: ["Larkspur Cold Chain", "LKSP"] };
const market: Group = { id: "market/public", description: "Public market news" };

describe("aliasHits", () => {
  test("aliases, an alias's short form and the group id match, case-insensitively", () => {
    assert.deepEqual(groupNames(falcon), ["Project Falcon", "Falcon", "Nimbus Logistics", "NMBL", "deal/falcon"]);
    for (const text of ["Notes on Project Falcon", "the falcon numbers", "NMBL rose", "nmbl rose", "NIMBUS  LOGISTICS\nboard deck", "Falcon's model", "saved to deal/falcon"]) {
      const hit = aliasHits(text, [falcon, trading]);
      assert.deepEqual(hit.groups, ["deal/falcon"], text);
      assert.match(hit.reason, /^code: alias .* → deal\/falcon$/, text);
    }
    assert.deepEqual(aliasHits("Project Falcon and Nimbus Logistics", [falcon]).names, ["Project Falcon", "Falcon", "Nimbus Logistics"]);
  });

  test("spelling tricks do not hide a name: _ joiners, the group id, run-together words, zero-width and look-alike characters", () => {
    const zwsp = "​";
    const tricks = [
      "Sent Falcon_LOI_v3.docx to the lender",
      "Moved the 9x model into the deal_falcon folder",
      "Moved the 9x model into deal-falcon/",
      "posted in #project_falcon",
      "ProjectFalcon kickoff",
      "projectfalcon.xlsx",
      "FalconModel_v2.xlsx",
      "FaLcOn price agreed",
      `Fal${zwsp}con price agreed at 12x`,
      `Fal­con price`, // soft hyphen
      `Fal⁠con price`, // word joiner
      "Fаlcon price", // Cyrillic а
      "Ｆａｌｃｏｎ price", // fullwidth
      "Fálcon price", // accent
      "Nimbus_Logistics board deck",
      "NimbusLogistics board deck",
      `Nimbus${zwsp} Logistics`,
      "bought NMBL_calls",
      "bought NMBLCalls",
    ];
    for (const text of tricks) assert.deepEqual(aliasHits(text, [falcon]).groups, ["deal/falcon"], JSON.stringify(text));
  });

  test("a group from an unchecked source with missing fields does not throw; a group with no aliases matches only its id", () => {
    const bare = { id: "deal/bare" } as unknown as Group;
    assert.deepEqual(groupNames(bare), ["deal/bare"]);
    assert.deepEqual(aliasHits("Bare minimum", [bare]).groups, []);
    assert.deepEqual(aliasHits("filed under deal_bare", [bare]).groups, ["deal/bare"]);
    assert.deepEqual(aliasHits("Reuters: freight volumes rose", [market]), { groups: [], names: [], reason: "" });
  });

  test("only on word boundaries", () => {
    for (const text of ["falconry weekend", "Nimbus Logisticsx", "the NMBLX fund", "", "public freight news", "dealfalconer", "Falconer Partners", "LKSPY"]) {
      const hit = aliasHits(text, [falcon, trading]);
      assert.deepEqual(hit.groups, [], text);
      assert.equal(hit.reason, "", text);
    }
  });

  test("a group id matches across one path or file-name joiner, never across sentence punctuation", () => {
    for (const text of ["filed under market/public", "market_public.csv", "market__public", "market-public", "MarketPublic notes", "marketpublic", "market\\public", "ｍａｒｋｅｔ_public"]) {
      assert.deepEqual(aliasHits(text, [market]).groups, ["market/public"], text);
    }
    for (const text of ["Nothing goes to market. Public comment only through Corvane IR.", "capital market public issuance", "market, public", "market\npublic", "market - public"]) {
      assert.deepEqual(aliasHits(text, [market]).groups, [], JSON.stringify(text));
    }
    // A camelCase boundary ends an id, so a file name that runs it into other words still names it.
    const bareFalcon = { id: "deal/falcon", aliases: [] };
    for (const text of ["DealFalconModel.xlsx", "Saved as myDealFalcon_v2.xlsx", "DEALFalconModel.xlsx", "deal_falconModel.xlsx"]) {
      assert.deepEqual(aliasHits(text, [bareFalcon]).groups, ["deal/falcon"], text);
    }
    assert.deepEqual(aliasHits("MarketPublicNotes.docx", [market]).groups, ["market/public"]);
    // Only a real boundary: a longer word is still not the id.
    for (const text of ["DealFalconer.xlsx", "dealfalconer", "SupermarketPublic", "MarketPublicity", "Deal Falcon Model"]) {
      assert.deepEqual(aliasHits(text, [bareFalcon, market]).groups, [], text);
    }
    // An alias keeps the looser rule: "Project  Falcon" across a line break still names Falcon.
    assert.deepEqual(aliasHits("Nimbus.\nLogistics", [{ id: "deal/x", aliases: ["Nimbus Logistics"] }]).groups, ["deal/x"]);
  });

  test("two groups named are both returned, in group-list order", () => {
    const hit = aliasHits("Harrow Rail may bid against Falcon; LKSP is up", [falcon, osprey, trading]);
    assert.deepEqual(hit.groups, ["deal/falcon", "deal/osprey", "desk/trading"]);
    assert.equal(hit.reason, 'code: alias "Falcon" → deal/falcon; "Harrow Rail" → deal/osprey; "LKSP" → desk/trading');
  });

  test("foldText is idempotent; matchForms adds the camelCase-split form only when it differs", () => {
    for (const s of ["Fal​con_LOI Fаlcon Ｆalcon Fálcon", "plain text", ""]) assert.equal(foldText(foldText(s)), foldText(s));
    assert.equal(foldText("Fal​con_LOI"), "Falcon LOI");
    assert.deepEqual(matchForms("plain text"), ["plain text"]);
    assert.deepEqual(matchForms("FalconModel"), ["FalconModel", "Falcon Model"]);
  });

  test("regex characters in names are literal", () => {
    const odd: Group = { id: "deal/odd", description: "x", aliases: ["Project A+B (2026)", "C.D."] };
    assert.deepEqual(aliasHits("about A+B (2026) today", [odd]).groups, ["deal/odd"]);
    assert.deepEqual(aliasHits("about AAB 2026 today", [odd]).groups, []);
    assert.deepEqual(aliasHits("CxD", [odd]).groups, []);
  });
});
