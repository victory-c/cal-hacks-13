import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationIdFor, extractTurns, pageTitle, SELECTORS } from "./chatgpt.ts";
import type { TurnElement } from "./chatgpt.ts";

/** A fake DOM root: a list of elements with a role attribute and text, like ChatGPT's turn nodes. */
function fakeRoot(nodes: Array<{ role: string | null; innerText?: string; textContent?: string | null }>) {
  return {
    querySelectorAll(selector: string): TurnElement[] {
      assert.equal(selector, SELECTORS.turn);
      return nodes.map((n) => ({
        getAttribute: (name: string) => (name === SELECTORS.roleAttr ? n.role : null),
        ...("innerText" in n ? { innerText: n.innerText } : {}),
        ...("textContent" in n ? { textContent: n.textContent } : {}),
      }));
    },
  };
}

test("extractTurns keeps user/assistant roles in page order with contiguous indexes", () => {
  const turns = extractTurns(
    fakeRoot([
      { role: "user", innerText: "  hello  " },
      { role: "assistant", innerText: "Hi! How can I help?" },
      { role: "user", innerText: "write a haiku" },
    ]),
  );
  assert.deepEqual(turns, [
    { role: "user", text: "hello", index: 0 },
    { role: "assistant", text: "Hi! How can I help?", index: 1 },
    { role: "user", text: "write a haiku", index: 2 },
  ]);
});

test("extractTurns skips empty turns and unknown roles, and renumbers", () => {
  const turns = extractTurns(
    fakeRoot([
      { role: "system", innerText: "You are ChatGPT" },
      { role: "user", innerText: "q" },
      { role: "assistant", innerText: "   \n  " }, // reply not streamed yet
      { role: null, innerText: "sidebar noise" },
      { role: "assistant", innerText: "a" },
    ]),
  );
  assert.deepEqual(turns, [
    { role: "user", text: "q", index: 0 },
    { role: "assistant", text: "a", index: 1 },
  ]);
});

test("extractTurns falls back to textContent when innerText is missing", () => {
  assert.deepEqual(extractTurns(fakeRoot([{ role: "user", textContent: " plain " }])), [{ role: "user", text: "plain", index: 0 }]);
  assert.deepEqual(extractTurns(fakeRoot([{ role: "user", textContent: null }])), []);
  assert.deepEqual(extractTurns(fakeRoot([])), []);
});

test("conversationIdFor reads /c/<id> (also under custom GPTs) and falls back to the tab id", () => {
  assert.equal(conversationIdFor("/c/68fa1234-abcd", "t1"), "68fa1234-abcd");
  assert.equal(conversationIdFor("/g/g-123-writer/c/68fa1234-abcd", "t1"), "68fa1234-abcd");
  assert.equal(conversationIdFor("/c/68fa1234-abcd/", "t1"), "68fa1234-abcd");
  assert.equal(conversationIdFor("/", "t1"), "new-t1");
  assert.equal(conversationIdFor("/gpts", "t1"), "new-t1");
});

test("pageTitle drops the site suffix and returns undefined for a bare site name", () => {
  assert.equal(pageTitle("Debounce notes"), "Debounce notes");
  assert.equal(pageTitle("Debounce notes | ChatGPT"), "Debounce notes");
  assert.equal(pageTitle("Debounce notes - ChatGPT"), "Debounce notes");
  assert.equal(pageTitle("ChatGPT"), undefined);
  assert.equal(pageTitle("New chat"), undefined);
  assert.equal(pageTitle("   "), undefined);
});
