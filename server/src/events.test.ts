import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { describe, test } from "node:test";

import { EVENT_REPLAY_LIMIT, parseSseChunk } from "@canon/shared";
import type { CanonEvent } from "@canon/shared";

import { EventBus } from "./events.ts";

const started = { type: "server.started", facts: 1, sessions: 2 } as const;

/** Just enough of ServerResponse for attachSse: records writes and lets the test fire "close". */
function fakeRes() {
  const chunks: string[] = [];
  const handlers = new Map<string, () => void>();
  let head: { status: number; headers: Record<string, string> } | undefined;
  const res = {
    writeHead: (status: number, headers: Record<string, string>) => {
      head = { status, headers };
      return res;
    },
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    on: (event: string, fn: () => void) => {
      handlers.set(event, fn);
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, chunks, handlers, head: () => head };
}

describe("EventBus", () => {
  test("emit fills `at` when missing and keeps a given one", () => {
    const bus = new EventBus();
    const e = bus.emit(started);
    assert.equal(e.type, "server.started");
    assert.match(e.at, /^\d{4}-\d{2}-\d{2}T/);
    const fixed = bus.emit({ ...started, at: "2026-10-24T00:00:00.000Z" });
    assert.equal(fixed.at, "2026-10-24T00:00:00.000Z");
  });

  test("ring buffer keeps the last `limit` events, oldest first", () => {
    const bus = new EventBus(3);
    for (let i = 0; i < 5; i++) bus.emit({ type: "server.started", facts: i, sessions: 0 });
    const facts = bus.replay().map((e) => (e.type === "server.started" ? e.facts : -1));
    assert.deepEqual(facts, [2, 3, 4]);
    assert.equal(bus.size, 3);
    assert.equal(new EventBus().size, 0);
    assert.ok(EVENT_REPLAY_LIMIT >= 3);
  });

  test("subscribe gets live events until unsubscribed; a throwing listener does not stop the others", () => {
    const bus = new EventBus();
    const seen: CanonEvent[] = [];
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const stopBad = bus.subscribe(() => {
        throw new Error("boom");
      });
      const stop = bus.subscribe((e) => seen.push(e));
      bus.emit(started);
      assert.equal(seen.length, 1);
      stop();
      stopBad();
      bus.emit(started);
      assert.equal(seen.length, 1);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("attachSse replays the buffer, streams live events with ids, and cleans up on close", () => {
    const bus = new EventBus();
    bus.emit(started);
    bus.emit({ type: "fact.retired", id: "fct_0001", superseded_by: "fct_0002" });
    const { res, chunks, handlers, head } = fakeRes();
    bus.attachSse(res);

    assert.equal(head()?.status, 200);
    assert.match(head()?.headers["Content-Type"] ?? "", /text\/event-stream/);
    assert.equal(head()?.headers["Access-Control-Allow-Origin"], "*");

    const replay = parseSseChunk(chunks.join("")).events;
    assert.deepEqual(
      replay.map((e) => [e.id, e.event]),
      [
        ["1", "server.started"],
        ["2", "fact.retired"],
      ],
    );

    bus.emit({ type: "access.denied", client: "chatgpt", tool: "canon_search", folder: "private" });
    const all = parseSseChunk(chunks.join("")).events;
    assert.equal(all.length, 3);
    assert.equal(all[2].id, "3");
    assert.equal((JSON.parse(all[2].data) as CanonEvent).type, "access.denied");

    handlers.get("close")?.();
    bus.emit(started);
    assert.equal(parseSseChunk(chunks.join("")).events.length, 3, "no writes after close");
  });
});
