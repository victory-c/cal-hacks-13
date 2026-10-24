import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { canRead, canWrite, folderAllows, grantFor, parseClientTokens } from "./grants.ts";
import { INBOX } from "./types/fact.ts";
import type { Folder } from "./types/fact.ts";
import { DEMO_GRANTS, INTERNAL_CLIENTS } from "./types/grants.ts";

describe("folderAllows", () => {
  test("allows the folder itself and anything nested under it", () => {
    assert.equal(folderAllows(["career"], "career"), true);
    assert.equal(folderAllows(["career"], "career/projects"), true);
    assert.equal(folderAllows(["career"], "career/projects/canon"), true);
    assert.equal(folderAllows(["career", "team"], "team/standups"), true);
  });

  test("a name that merely starts with the grant is NOT allowed (careers vs career)", () => {
    // Not valid Folder values, which is the point: a typo'd or hostile folder name must not match.
    assert.equal(folderAllows(["career"], "careers" as Folder), false);
    assert.equal(folderAllows(["career"], "careers/x" as Folder), false);
    assert.equal(folderAllows(["career/projects"], "career"), false);
    assert.equal(folderAllows([], "career"), false);
  });
});

describe("DEMO_GRANTS", () => {
  const aiClients = DEMO_GRANTS.filter((g) => !(INTERNAL_CLIENTS as readonly string[]).includes(g.client));

  test("has the demo AI clients, the synthetic-world people and the internal workers", () => {
    assert.deepEqual(
      DEMO_GRANTS.map((g) => g.client).sort(),
      ["chatgpt", "claude-code", "dan", "dispatcher", "distiller", "leo", "maya", "priya", "teammate-cursor"],
    );
    assert.ok(aiClients.length >= 3);
  });

  test("the synthetic-world people act for their own principal and hold no folder grants", () => {
    for (const person of ["maya", "dan", "priya", "leo"]) {
      const g = grantFor(DEMO_GRANTS, person);
      assert.ok(g, `${person} must have a grant`);
      assert.equal(g.principal, person);
      assert.deepEqual(g.read, []);
      assert.deepEqual(g.write, []);
    }
  });

  test("no AI client reads or writes private/ or the inbox; only INTERNAL_CLIENTS may", () => {
    for (const g of aiClients) {
      for (const folder of ["private", "private/health", INBOX] as const) {
        assert.equal(canRead(g, folder), false, `${g.client} must not read ${folder}`);
        assert.equal(canWrite(g, folder), false, `${g.client} must not write ${folder}`);
      }
    }
    const distiller = grantFor(DEMO_GRANTS, "distiller");
    assert.ok(distiller);
    assert.equal(canWrite(distiller, "private/health"), true);
  });

  test("matches the CLAUDE.md table", () => {
    const cc = grantFor(DEMO_GRANTS, "claude-code")!;
    assert.equal(canRead(cc, "projects/canon"), true);
    assert.equal(canRead(cc, "career"), true);
    assert.equal(canWrite(cc, "projects"), true);
    assert.equal(canWrite(cc, "career"), false);
    const gpt = grantFor(DEMO_GRANTS, "chatgpt")!;
    assert.equal(canRead(gpt, "career/projects"), true);
    assert.equal(canRead(gpt, "projects"), false);
    assert.equal(canWrite(gpt, "career"), false);
    assert.equal(grantFor(DEMO_GRANTS, "nobody"), undefined);
  });
});

describe("parseClientTokens", () => {
  test("maps token → client, trims spaces, skips junk", () => {
    const m = parseClientTokens(" claude-code = dev-claude-code , junk, =orphan, chatgpt=dev-chatgpt,, novalue= ,x=y=z");
    assert.deepEqual([...m.entries()], [
      ["dev-claude-code", "claude-code"],
      ["dev-chatgpt", "chatgpt"],
      ["y=z", "x"],
    ]);
  });

  test("undefined and empty input give an empty map", () => {
    assert.equal(parseClientTokens(undefined).size, 0);
    assert.equal(parseClientTokens("").size, 0);
  });
});
