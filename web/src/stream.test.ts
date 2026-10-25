import assert from "node:assert/strict";
import { test } from "node:test";
import { readEventStream, subscribeEvents } from "./stream.ts";

test("SSE parser handles partial UTF-8, comments, CRLF and multiline data", async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\nevent: fact.saved\r\ndata: {"text":\r\ndata: "✓"}\r\n\r\nevent: scope.changed\ndata: {}\n\n');
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (let n = 0; n < bytes.length; n += 3) controller.enqueue(bytes.slice(n, n + 3)); controller.close(); } });
  const seen: [string, string][] = [];
  await readEventStream(stream, (type, data) => seen.push([type, data]));
  assert.deepEqual(seen, [["fact.saved", '{"text":\n"✓"}'], ["scope.changed", "{}"]]);
});

test("live subscriptions use a bearer header and close without putting credentials in URLs", async (t) => {
  let requested = "";
  let request: RequestInit | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => { requested = url; request = options; return new Response(stream); });
  const events: unknown[] = [];
  const statuses: string[] = [];
  const close = subscribeEvents("https://preview.example", "private-token", ["fact.saved"], (event) => events.push(event), (status) => statuses.push(status));
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller!.enqueue(new TextEncoder().encode('event: fact.saved\ndata: {"id":"fct_1234"}\n\nevent: secret\ndata: {}\n\n'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  close();
  controller!.close();
  assert.equal(requested, "https://preview.example/events");
  assert.equal((request!.headers as Record<string, string>).authorization, "Bearer private-token");
  assert.equal(request!.signal!.aborted, true);
  assert.deepEqual(events, [{ id: "fct_1234" }]);
  assert.deepEqual(statuses, ["connecting", "live"]);
});
