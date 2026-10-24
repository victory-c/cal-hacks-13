import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatSseEvent, parseSseChunk, subscribeEvents } from "./sse.ts";
import { serve } from "./test-helpers.ts";
import type { CanonEvent } from "./types/events.ts";

const started: CanonEvent = { type: "server.started", at: "2026-10-24T03:12:00.000Z", facts: 3, sessions: 1 };
const denied: CanonEvent = { type: "access.denied", at: "2026-10-24T03:13:00.000Z", client: "chatgpt", tool: "canon_search", folder: "private" };

describe("parseSseChunk", () => {
  test("parses event, data and id; a blank line dispatches", () => {
    const { events, rest } = parseSseChunk('event: fact.saved\ndata: {"a":1}\nid: 7\n\n');
    assert.deepEqual(events, [{ event: "fact.saved", data: '{"a":1}', id: "7" }]);
    assert.equal(rest, "");
  });

  test("buffers across chunk boundaries split mid-line and mid-event", () => {
    let buf = "event: fact.sa";
    let r = parseSseChunk(buf);
    assert.deepEqual(r.events, []);
    assert.equal(r.rest, buf);

    buf = r.rest + 'ved\ndata: {"a":';
    r = parseSseChunk(buf);
    assert.deepEqual(r.events, []);
    assert.equal(r.rest, buf, "complete field lines of an unterminated event stay in rest");

    buf = r.rest + "1}\n\nevent: next\n";
    r = parseSseChunk(buf);
    assert.deepEqual(r.events, [{ event: "fact.saved", data: '{"a":1}' }]);
    assert.equal(r.rest, "event: next\n");
  });

  test("joins multi-line data with \\n, ignores comments and unknown fields, handles CRLF", () => {
    const { events, rest } = parseSseChunk(": keep-alive\r\n\r\ndata: line 1\r\nretry: 3000\r\n: comment\r\ndata: line 2\r\nfoo: bar\r\n\r\n");
    assert.deepEqual(events, [{ data: "line 1\nline 2" }]);
    assert.equal(rest, "");
  });

  test("strips exactly one leading space from values and keeps the rest", () => {
    assert.deepEqual(parseSseChunk("data:  two spaces\n\n").events, [{ data: " two spaces" }]);
    assert.deepEqual(parseSseChunk("data:nospace\n\n").events, [{ data: "nospace" }]);
  });

  test("a blank line without data dispatches nothing but is consumed", () => {
    assert.deepEqual(parseSseChunk("event: ping\n\n"), { events: [], rest: "" });
  });
});

test("formatSseEvent → parseSseChunk roundtrips, with and without id", () => {
  const wire = formatSseEvent(started, "42") + formatSseEvent(denied);
  assert.equal(wire.startsWith("id: 42\nevent: server.started\ndata: {"), true);
  const { events, rest } = parseSseChunk(wire);
  assert.equal(rest, "");
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "server.started");
  assert.equal(events[0].id, "42");
  assert.deepEqual(JSON.parse(events[0].data), started);
  assert.equal(events[1].event, "access.denied");
  assert.equal(events[1].id, undefined);
  assert.deepEqual(JSON.parse(events[1].data), denied);
});

describe("subscribeEvents", () => {
  test("receives events, drops non-JSON with onError, reconnects when the server closes", { timeout: 5000 }, async () => {
    let connections = 0;
    const seenHeaders: string[] = [];
    const { url, close } = await serve((req, res) => {
      connections++;
      seenHeaders.push(String(req.headers.authorization));
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (connections === 1) {
        res.write(formatSseEvent(started, "1"));
        res.write("event: fact.saved\ndata: not json\n\n");
        res.write('data: {"no":"type"}\n\n');
        res.end(); // dropped connection: the client must come back on its own
      } else {
        res.write(formatSseEvent(denied, "2")); // stays open until the test closes the server
      }
    });

    const got: CanonEvent[] = [];
    const errors: unknown[] = [];
    let opens = 0;
    let unsubscribe = () => {};
    await new Promise<void>((resolve) => {
      unsubscribe = subscribeEvents(
        `${url}/events`,
        (e) => {
          got.push(e);
          if (got.length === 2) resolve();
        },
        { retryMs: 10, headers: { authorization: "Bearer dev-token" }, onOpen: () => opens++, onError: (e) => errors.push(e) },
      );
    });
    unsubscribe();
    unsubscribe(); // idempotent

    assert.equal(opens, 2);
    assert.equal(connections, 2);
    assert.deepEqual(seenHeaders, ["Bearer dev-token", "Bearer dev-token"]);
    assert.deepEqual(got, [started, denied]);
    const messages = errors.map((e) => (e instanceof Error ? e.message : String(e)));
    assert.ok(messages.some((m) => m.includes("is not JSON")), messages.join(" | "));
    assert.ok(messages.some((m) => m.includes('no "type" field')), messages.join(" | "));
    assert.ok(messages.some((m) => m.includes("stream closed by server")), messages.join(" | "));
    await close();
  });

  test("reconnects when the stream goes silent for idleMs (dead socket, no close)", { timeout: 5000 }, async () => {
    let connections = 0;
    const { url, close } = await serve((_req, res) => {
      connections++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(formatSseEvent(started, "1"));
      // Then nothing: no events, no heartbeat, no close. The client must notice on its own.
    });

    const got: CanonEvent[] = [];
    const errors: unknown[] = [];
    let unsubscribe = () => {};
    await new Promise<void>((resolve) => {
      unsubscribe = subscribeEvents(
        `${url}/events`,
        (e) => {
          got.push(e);
          if (got.length === 2) resolve();
        },
        { retryMs: 5, idleMs: 60, onError: (e) => errors.push(e) },
      );
    });
    unsubscribe();

    assert.equal(connections, 2);
    assert.deepEqual(got, [started, started]);
    const messages = errors.map((e) => (e instanceof Error ? e.message : String(e)));
    assert.ok(messages.some((m) => m.includes("idle for 60 ms")), messages.join(" | "));
    await close();
  });

  test("heartbeat comment lines keep an otherwise idle stream alive", { timeout: 5000 }, async () => {
    let connections = 0;
    const timers: NodeJS.Timeout[] = [];
    const { url, close } = await serve((_req, res) => {
      connections++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": canon events\n\n");
      timers.push(setInterval(() => res.write(": ping\n\n"), 20)); // like the server, only faster
    });

    const errors: unknown[] = [];
    let opens = 0;
    const unsubscribe = subscribeEvents(`${url}/events`, () => assert.fail("no events expected"), {
      retryMs: 5,
      idleMs: 80,
      onOpen: () => opens++,
      onError: (e) => errors.push(e),
    });
    await new Promise((r) => setTimeout(r, 300)); // several idle windows' worth
    unsubscribe();
    for (const t of timers) clearInterval(t);

    assert.equal(opens, 1);
    assert.equal(connections, 1, "heartbeats must reset the idle timer");
    assert.deepEqual(errors, []);
    await close();
  });

  test("stops when the signal aborts and never calls back afterwards", { timeout: 5000 }, async () => {
    let connections = 0;
    const { url, close } = await serve((_req, res) => {
      connections++;
      res.writeHead(500);
      res.end();
    });
    const ac = new AbortController();
    const errors: unknown[] = [];
    const firstError = new Promise<void>((resolve) => {
      subscribeEvents(`${url}/events`, () => assert.fail("no events expected"), {
        retryMs: 5,
        signal: ac.signal,
        onError: (e) => {
          errors.push(e);
          resolve();
        },
      });
    });
    await firstError;
    ac.abort();
    const after = errors.length;
    const connsAfter = connections;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(errors.length, after, "no onError after abort");
    assert.equal(connections, connsAfter, "no reconnect after abort");
    assert.match(String((errors[0] as Error).message), /HTTP 500/);
    await close();
  });
});
