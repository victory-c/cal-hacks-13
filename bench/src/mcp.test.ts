import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { MCP_PROTOCOL_VERSION, mcpCall, mcpToolCall, parseMcpBody } from "./mcp.ts";
import { fakeFetch } from "./test-helpers.ts";

const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
const sse = (messages: unknown[], headers: Record<string, string> = {}) =>
  new Response(messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream", ...headers } });
const accepted = () => new Response(null, { status: 202 });

const initResult = { jsonrpc: "2.0", id: 1, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: "canon", version: "0" } } };
const toolResult = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: '{"facts":[]}' }], structuredContent: { facts: [] } } };

describe("parseMcpBody", () => {
  test("a JSON body is the message", () => {
    assert.deepEqual(parseMcpBody("application/json", JSON.stringify(toolResult)), toolResult);
  });

  test("an SSE body: picks the message with the wanted id, else the last one", () => {
    const notice = { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } };
    const body = `event: message\ndata: ${JSON.stringify(toolResult)}\n\nevent: message\ndata: ${JSON.stringify(notice)}\n\n`;
    assert.deepEqual(parseMcpBody("text/event-stream; charset=utf-8", body, 2), toolResult);
    assert.deepEqual(parseMcpBody("text/event-stream", body), notice);
    assert.deepEqual(parseMcpBody("text/event-stream", `data: ${JSON.stringify(toolResult)}`), toolResult, "no event name and no trailing blank line still parses");
  });

  test("rejects bodies that are neither JSON nor SSE, and non JSON-RPC payloads", () => {
    assert.throws(() => parseMcpBody("text/html", "<html>"), /neither JSON nor SSE/);
    assert.throws(() => parseMcpBody("application/json", '{"hello":1}'), /not a JSON-RPC 2.0 message/);
    assert.throws(() => parseMcpBody("text/event-stream", ": keep-alive\n\n"), /no message events/);
  });
});

describe("mcpCall", () => {
  test("initialize → initialized → method, carrying the session id, and closes the session", async () => {
    const { fetch, calls } = fakeFetch([
      () => json(initResult, { "mcp-session-id": "sess-42" }),
      () => accepted(),
      () => sse([{ jsonrpc: "2.0", method: "notifications/message", params: {} }, toolResult]),
      () => new Response(null, { status: 405 }),
    ]);
    const result = await mcpCall("http://canon.test/mcp", "tok-claude-code", "tools/call", { name: "canon_context", arguments: { task: "q" } }, { fetch });
    assert.deepEqual(result, toolResult.result);

    assert.equal(calls.length, 4);
    const headers = (i: number) => calls[i].init.headers as Record<string, string>;
    assert.equal(headers(0).accept, "application/json, text/event-stream");
    assert.equal(headers(0)["mcp-protocol-version"], MCP_PROTOCOL_VERSION);
    assert.equal(headers(0).authorization, "Bearer tok-claude-code");
    assert.equal("mcp-session-id" in headers(0), false, "no session before initialize answers");
    assert.equal(headers(1)["mcp-session-id"], "sess-42");
    assert.equal(headers(2)["mcp-session-id"], "sess-42");

    const bodies = calls.map((c) => c.body as Record<string, unknown>);
    assert.equal(bodies[0].method, "initialize");
    assert.deepEqual((bodies[0].params as Record<string, unknown>).protocolVersion, MCP_PROTOCOL_VERSION);
    assert.equal(bodies[1].method, "notifications/initialized");
    assert.equal("id" in bodies[1], false, "notifications carry no id");
    assert.equal(bodies[2].method, "tools/call");
    assert.deepEqual(bodies[2].params, { name: "canon_context", arguments: { task: "q" } });
    assert.equal(calls[3].init.method, "DELETE");
  });

  test("a JSON-RPC error and an HTTP error each surface the server's message", async () => {
    const denied = fakeFetch([
      () => json(initResult),
      () => accepted(),
      () => json({ jsonrpc: "2.0", id: 2, error: { code: -32602, message: "chatgpt may not read private/" } }),
    ]);
    await assert.rejects(mcpCall("http://canon.test/mcp", "t", "tools/call", {}, { fetch: denied.fetch }), /MCP tools\/call: chatgpt may not read private\/ \(code -32602\)/);

    const unauthorized = fakeFetch([() => new Response("bad token", { status: 401 })]);
    await assert.rejects(mcpCall("http://canon.test/mcp", "t", "tools/call", {}, { fetch: unauthorized.fetch }), /MCP initialize: HTTP 401 .*bad token/);

    const down = fakeFetch([
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    await assert.rejects(mcpCall("http://canon.test/mcp", "t", "tools/call", {}, { fetch: down.fetch }), /request to http:\/\/canon.test\/mcp failed: fetch failed. Is the Canon server running\?/);
  });
});

describe("mcpToolCall", () => {
  test("unwraps text blocks, structuredContent and isError", async () => {
    const { fetch } = fakeFetch([
      () => json(initResult),
      () => accepted(),
      () => json({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "a" }, { type: "image", data: "" }, { type: "text", text: "b" }], structuredContent: { x: 1 }, isError: true } }),
    ]);
    const r = await mcpToolCall("http://canon.test/mcp", "t", "canon_whoami", {}, { fetch });
    assert.equal(r.text, "a\nb");
    assert.deepEqual(r.structured, { x: 1 });
    assert.equal(r.isError, true);
  });

  test("a result without content is an error, not a silent empty context", async () => {
    const { fetch } = fakeFetch([() => json(initResult), () => accepted(), () => json({ jsonrpc: "2.0", id: 2, result: { ok: true } })]);
    await assert.rejects(mcpToolCall("http://canon.test/mcp", "t", "canon_context", {}, { fetch }), /has no "content" array/);
  });
});
