// Minimal MCP Streamable HTTP client over plain fetch (JSON-RPC 2.0). bench must not depend on
// @modelcontextprotocol/sdk, and the three requests we need (initialize, the initialized
// notification, one tools/call) are small. The server may answer with a JSON body or with an
// SSE body; both are handled. Every mcpCall() is a fresh MCP session, closed best-effort.

import { parseSseChunk } from "@canon/shared";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface McpOptions {
  /** Injected by tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

/** A tools/call result. `text` joins the text content blocks; `structured` is structuredContent. */
export interface McpToolResult {
  text: string;
  structured?: unknown;
  isError: boolean;
  raw: unknown;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Reads one JSON-RPC message out of a response body. A JSON body is the message. An SSE body
 * may carry several messages (notifications, then the response): we take the one whose id matches
 * `wantId`, else the last message event.
 */
export function parseMcpBody(contentType: string | null, body: string, wantId?: number | string): JsonRpcResponse {
  let parsed: unknown;
  if (contentType?.includes("text/event-stream")) {
    const { events } = parseSseChunk(body.endsWith("\n\n") ? body : `${body}\n\n`);
    const messages = events.filter((e) => e.event === undefined || e.event === "message");
    if (messages.length === 0) throw new Error(`MCP: SSE body had no message events: ${body.slice(0, 200)}`);
    const decoded = messages.map((m) => {
      try {
        return JSON.parse(m.data) as unknown;
      } catch {
        throw new Error(`MCP: SSE message is not JSON: ${m.data.slice(0, 200)}`);
      }
    });
    parsed = (wantId !== undefined && decoded.find((d) => isRecord(d) && d.id === wantId)) || decoded[decoded.length - 1];
  } else {
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error(`MCP: response is neither JSON nor SSE (content-type ${contentType ?? "none"}): ${body.slice(0, 200)}`);
    }
  }
  if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") {
    throw new Error(`MCP: response is not a JSON-RPC 2.0 message: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  // Shape checked above; the cast only restates what was verified.
  return parsed as unknown as JsonRpcResponse;
}

/**
 * initialize → notifications/initialized → `method`, all as POSTs to the MCP endpoint with the
 * client's bearer token. Returns the JSON-RPC `result` of `method`; throws with the server's
 * message on a JSON-RPC error or a non-2xx status.
 */
export async function mcpCall(url: string, token: string, method: string, params: unknown, opts: McpOptions = {}): Promise<unknown> {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let sessionId: string | undefined;

  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    authorization: `Bearer ${token}`,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  });

  const post = async (message: Record<string, unknown>, label: string): Promise<JsonRpcResponse | undefined> => {
    let res: Response;
    try {
      res = await doFetch(url, { method: "POST", headers: headers(), body: JSON.stringify(message), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new Error(`MCP ${label}: request to ${url} failed: ${e instanceof Error ? e.message : String(e)}. Is the Canon server running?`, { cause: e });
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) sessionId = sid;
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP ${label}: HTTP ${res.status} from ${url}${text ? `: ${text.slice(0, 300)}` : ""}`);
    // Notifications are answered with 202 and an empty body.
    if (res.status === 202 || text.trim() === "") return undefined;
    const msg = parseMcpBody(res.headers.get("content-type"), text, typeof message.id === "number" ? message.id : undefined);
    if (msg.error) throw new Error(`MCP ${label}: ${msg.error.message} (code ${msg.error.code})`);
    return msg;
  };

  const init = await post(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "canon-bench", version: "0.1.0" } },
    },
    "initialize",
  );
  if (!init || !isRecord(init.result)) throw new Error(`MCP initialize: no result from ${url}`);

  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, "notifications/initialized");

  try {
    const res = await post({ jsonrpc: "2.0", id: 2, method, params }, method);
    if (!res) throw new Error(`MCP ${method}: empty response from ${url}`);
    return res.result;
  } finally {
    // Spec: clients SHOULD end the session with DELETE; servers MAY answer 405. Either is fine.
    if (sessionId) {
      await doFetch(url, { method: "DELETE", headers: headers(), signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    }
  }
}

/** tools/call sugar: unwraps the MCP tool result shape. Throws when the result is malformed. */
export async function mcpToolCall(url: string, token: string, name: string, args: unknown, opts: McpOptions = {}): Promise<McpToolResult> {
  const raw = await mcpCall(url, token, "tools/call", { name, arguments: args }, opts);
  if (!isRecord(raw) || !Array.isArray(raw.content)) {
    throw new Error(`MCP tools/call ${name}: result has no "content" array: ${JSON.stringify(raw).slice(0, 200)}`);
  }
  const text = raw.content
    .filter((b): b is Record<string, unknown> => isRecord(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
  const out: McpToolResult = { text, isError: raw.isError === true, raw };
  if (raw.structuredContent !== undefined) out.structured = raw.structuredContent;
  return out;
}
