// Raw Messages API over fetch for the dispatcher (planner, brief writer, Claude fallback runner).
// Same rules as ../engines/claude.ts and shared/src/judge/claude.ts, from the claude-api skill:
//   - claude-sonnet-5-5 rejects forced tool_choice ("any" / "tool") with a 400, so callers send
//     "auto" + `strict: true` tools + a system prompt naming the tool, and check the call came back;
//   - thinking is adaptive by default (no `thinking` field); depth via output_config.effort;
//     no temperature/top_p (a 400 on API version 2026-10-21);
//   - `fallbacks: "default"` (beta server-side-fallback-2026-07-01) retries a safeguard decline;
//   - stop_reason is checked before content; content blocks are read by type, never position;
//   - in a tool loop the assistant's content goes back unchanged (thinking blocks included),
//     history is append-only.
// No SDK: this package stays dependency-free.

import { env } from "@canon/shared";

export const SONNET = "claude-sonnet-5-5";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2026-10-21";
const BETAS = "server-side-fallback-2026-07-01";

export type Block = Record<string, unknown> & { type: string };

export interface MessagesResponse {
  content: Block[];
  stop_reason: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface CallOptions {
  /** Prefix for error messages ("planner", "brief", "claude runner"). */
  who: string;
  apiKey?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export function hasAnthropicKey(): boolean {
  return Boolean(env("ANTHROPIC_API_KEY"));
}

/** POST /v1/messages. Throws with a readable message on HTTP errors and refusals. */
export async function createMessage(body: Record<string, unknown>, opts: CallOptions): Promise<MessagesResponse> {
  const apiKey = opts.apiKey ?? env("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error(`${opts.who}: ANTHROPIC_API_KEY is not set`);
  // Same override the official SDK honours. Tests point it at a local server.
  const baseUrl = env("ANTHROPIC_BASE_URL", DEFAULT_BASE_URL).replace(/\/+$/, "");
  const signals = [AbortSignal.timeout(opts.timeoutMs), ...(opts.signal ? [opts.signal] : [])];
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": API_VERSION, "anthropic-beta": BETAS },
      body: JSON.stringify({ fallbacks: "default", ...body }),
      signal: AbortSignal.any(signals),
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err; // a cancel, not a network failure: let the caller see the abort
    throw new Error(`${opts.who}: request to ${baseUrl} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${opts.who}: HTTP ${res.status}: ${apiErrorMessage(text)}`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${opts.who}: non-JSON response: ${text.slice(0, 300)}`);
  }
  if (!isRecord(json)) throw new Error(`${opts.who}: response is not an object`);
  if (json.stop_reason === "refusal") {
    const details = isRecord(json.stop_details) ? json.stop_details : {};
    throw new Error(`${opts.who}: Claude declined (category: ${String(details.category ?? "unknown")})`);
  }
  const content = Array.isArray(json.content) ? json.content.filter((b): b is Block => isRecord(b) && typeof b.type === "string") : [];
  return { content, stop_reason: String(json.stop_reason ?? ""), usage: isRecord(json.usage) ? (json.usage as MessagesResponse["usage"]) : undefined };
}

export function textOf(resp: MessagesResponse): string {
  return resp.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => String(b.text))
    .join("\n")
    .trim();
}

export function toolCalls(resp: MessagesResponse): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  return resp.content
    .filter((b) => b.type === "tool_use" && typeof b.name === "string")
    .map((b) => ({ id: String(b.id ?? ""), name: String(b.name), input: isRecord(b.input) ? b.input : {} }));
}

/** Real token counts from `usage`, or undefined. Never estimated. */
export function usageOf(resp: MessagesResponse): { input: number; output: number } | undefined {
  const u = resp.usage;
  if (u && typeof u.input_tokens === "number" && typeof u.output_tokens === "number") return { input: u.input_tokens, output: u.output_tokens };
  return undefined;
}

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function apiErrorMessage(text: string): string {
  try {
    const j: unknown = JSON.parse(text);
    if (isRecord(j) && isRecord(j.error) && typeof j.error.message === "string") return j.error.message;
  } catch {
    // not JSON; fall through to the raw body
  }
  return text.slice(0, 300);
}
