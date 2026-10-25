import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { conversationIdFor, extractTurns, pageTitle, RETRY_BASE_MS, RETRY_MAX_ATTEMPTS, RETRY_MAX_MS, SELECTORS, SnapshotSender } from "./chatgpt.ts";
import type { TurnElement } from "./chatgpt.ts";
import type { TurnsMessage } from "../shared/protocol.ts";

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

// --- SnapshotSender: delivery to the service worker (issue #23) ----------------------------------

mock.method(console, "debug", () => {}); // failed deliveries are logged at debug level; keep test output clean

/** Manual timers and a scripted chrome.runtime.sendMessage: each call takes the next reply. */
function harness(replies: Array<"ok" | "reject" | "throw" | "no-reply">) {
  const sent: TurnsMessage[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextId = 1;
  const sender = new SnapshotSender({
    send(msg) {
      sent.push(msg);
      const reply = replies.shift() ?? "ok";
      if (reply === "throw") throw new Error("Extension context invalidated.");
      if (reply === "reject") return Promise.reject(new Error("Could not establish connection. Receiving end does not exist."));
      return Promise.resolve(reply === "ok" ? { ok: true } : undefined);
    },
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
  });
  const settle = () => new Promise((r) => setImmediate(r));
  /** Fires the pending retry timer (there is at most one) and returns its delay. */
  const fireRetry = async (): Promise<number> => {
    assert.equal(timers.size, 1, "exactly one retry is scheduled");
    const [id, t] = [...timers][0];
    timers.delete(id);
    t.fn();
    await settle();
    return t.ms;
  };
  return { sender, sent, timers, settle, fireRetry };
}

const snap = (text: string, ended = false): [TurnsMessage, string] => {
  const turns = [{ role: "user" as const, text, index: 0 }];
  const msg: TurnsMessage = { kind: "turns", site: "chatgpt", conversationId: "c1", url: "https://chatgpt.com/c/c1", turns };
  if (ended) msg.ended = true;
  return [msg, JSON.stringify(["c1", turns])];
};

test("SnapshotSender retries an unchanged snapshot after a runtime rejection and recovers", async () => {
  const h = harness(["reject", "ok"]);
  h.sender.offer(...snap("stable"));
  await h.settle();
  assert.equal(h.sent.length, 1);
  h.sender.offer(...snap("stable")); // DOM noise while backing off: no extra send, no extra timer
  await h.settle();
  assert.equal(h.sent.length, 1);
  assert.equal(await h.fireRetry(), RETRY_BASE_MS);
  assert.equal(h.sent.length, 2, "the unchanged transcript is delivered once the worker is back");
  h.sender.offer(...snap("stable")); // now it is delivered, so duplicates are skipped again
  await h.settle();
  assert.equal(h.sent.length, 2);
  assert.equal(h.timers.size, 0);
});

test("SnapshotSender treats a synchronous throw or a reply without ok: true as not delivered", async () => {
  const h = harness(["throw", "no-reply", "ok"]);
  h.sender.offer(...snap("q"));
  await h.settle();
  assert.equal(await h.fireRetry(), RETRY_BASE_MS);
  assert.equal(await h.fireRetry(), RETRY_BASE_MS * 2);
  assert.equal(h.sent.length, 3);
  assert.equal(h.timers.size, 0);
});

test("SnapshotSender coalesces snapshots that arrive during a retry or an in-flight send into the latest", async () => {
  const h = harness(["reject", "ok", "ok"]);
  h.sender.offer(...snap("v1"));
  await h.settle();
  h.sender.offer(...snap("v2"));
  h.sender.offer(...snap("v3"));
  await h.fireRetry();
  assert.deepEqual(h.sent.map((m) => m.turns[0].text), ["v1", "v3"], "the retry sends only the newest snapshot");
  // While one send is in flight, newer snapshots wait in one slot and go right after the ack.
  h.sender.offer(...snap("v4"));
  h.sender.offer(...snap("v5"));
  h.sender.offer(...snap("v6"));
  await h.settle();
  assert.deepEqual(h.sent.map((m) => m.turns[0].text), ["v1", "v3", "v4", "v6"]);
});

test("SnapshotSender backoff is capped, gives up after RETRY_MAX_ATTEMPTS, and the next capture sends again", async () => {
  const h = harness(Array(RETRY_MAX_ATTEMPTS).fill("reject"));
  h.sender.offer(...snap("q"));
  await h.settle();
  const delays: number[] = [];
  while (h.timers.size > 0) delays.push(await h.fireRetry());
  assert.equal(h.sent.length, RETRY_MAX_ATTEMPTS);
  assert.equal(delays.length, RETRY_MAX_ATTEMPTS - 1);
  assert.ok(delays.every((d, i) => d === Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** i)));
  assert.equal(Math.max(...delays), RETRY_MAX_MS);
  h.sender.offer(...snap("q")); // same transcript: never delivered, so it is not suppressed
  await h.settle();
  assert.equal(h.sent.length, RETRY_MAX_ATTEMPTS + 1);
});

test("SnapshotSender sends the final (ended) snapshot at once, even while backing off or already delivered", async () => {
  const h = harness(["reject", "ok", "ok"]);
  h.sender.offer(...snap("q"));
  await h.settle();
  assert.equal(h.timers.size, 1);
  h.sender.offer(...snap("q", true));
  await h.settle();
  assert.equal(h.timers.size, 0, "pagehide does not wait out the backoff");
  assert.equal(h.sent.at(-1)?.ended, true);
  h.sender.offer(...snap("q", true)); // a delivered fingerprint does not suppress the final snapshot
  await h.settle();
  assert.equal(h.sent.length, 3);
});
