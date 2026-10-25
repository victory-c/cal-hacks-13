// Responders answer the task question from an injected context. ClaudeResponder is the real one
// (Messages API, claude-sonnet-5-5 per CLAUDE.md, `usage` recorded so token counts are real).
// EchoResponder is the --dry / no-key stub: no model runs, its output is labelled simulated and
// is never scored as right or wrong.
//
// Raw fetch, not @anthropic-ai/sdk: bench has no SDK dependency and may not add one. The request
// follows the claude-api skill (POST {base}/v1/messages, x-api-key, anthropic-version). No
// `thinking` field: Sonnet 5.5 runs adaptive thinking by default. No `temperature`: rejected on
// this API version. No `fallbacks`: a benchmark measures one fixed model, so a refusal is an error
// for that cell rather than an answer from another model.

import { env, estimateTokens, timed } from "@canon/shared";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface Answered {
  text: string;
  /** Real token counts from the model. Absent when simulated. */
  usage?: Usage;
  ms: number;
  simulated?: boolean;
}

export interface Responder {
  readonly name: string;
  readonly model?: string;
  readonly simulated: boolean;
  /** `system` overrides the default system prompt (the finance setups carry their own). */
  answer(context: string, question: string, system?: string): Promise<Answered>;
}

const DEFAULT_MODEL = "claude-sonnet-5-5";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2026-10-21";
// Answers are a few sentences; thinking tokens count toward this too, so leave headroom.
const DEFAULT_MAX_TOKENS = 4096;
const TIMEOUT_MS = 120_000;

const SYSTEM = `You are answering one question for a student using only the CONTEXT below, which another AI session saved earlier. The context may be empty.
Answer in at most three sentences, using the specific names, numbers and dates from the context. If the context does not contain the answer, say exactly what is missing instead of guessing.`;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export class ClaudeResponder implements Responder {
  readonly name = "claude";
  readonly model: string;
  readonly simulated = false;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly doFetch: typeof fetch;

  constructor(opts: { apiKey?: string; model?: string; maxTokens?: number; fetch?: typeof fetch } = {}) {
    const apiKey = opts.apiKey ?? env("ANTHROPIC_API_KEY");
    if (!apiKey) throw new Error("ClaudeResponder: ANTHROPIC_API_KEY is not set. Put it in .env, or run with --dry.");
    this.apiKey = apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.doFetch = opts.fetch ?? fetch;
    // Same override the official SDK honours; tests point it at a local server.
    this.baseUrl = env("ANTHROPIC_BASE_URL", DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async answer(context: string, question: string, system?: string): Promise<Answered> {
    const body = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: system ?? SYSTEM,
      messages: [{ role: "user", content: `CONTEXT:\n${context.trim() === "" ? "(empty)" : context}\n\nQUESTION:\n${question}` }],
    };
    const { result: json, ms } = await timed(async () => {
      let res: Response;
      try {
        res = await this.doFetch(`${this.baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": API_VERSION },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        throw new Error(`ClaudeResponder: request to ${this.baseUrl} failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`ClaudeResponder: HTTP ${res.status}: ${apiErrorMessage(text)}`);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error(`ClaudeResponder: non-JSON response: ${text.slice(0, 300)}`);
      }
    });

    if (!isRecord(json)) throw new Error("ClaudeResponder: response is not an object");
    if (json.stop_reason === "refusal") {
      const details = isRecord(json.stop_details) ? json.stop_details : {};
      throw new Error(`ClaudeResponder: Claude declined to answer (category: ${String(details.category ?? "unknown")})`);
    }
    if (json.stop_reason === "max_tokens") {
      console.warn(`[bench] responder hit max_tokens=${this.maxTokens}; the answer may be cut short`);
    }
    // Content blocks are read by type, never by position (thinking blocks may come first).
    const content = Array.isArray(json.content) ? json.content : [];
    const text = content
      .filter((b): b is Record<string, unknown> => isRecord(b) && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n")
      .trim();

    const out: Answered = { text, ms };
    const usage = isRecord(json.usage) ? json.usage : undefined;
    if (usage && typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number") {
      out.usage = { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
    } else {
      console.warn("[bench] responder: response carried no usage; token counts for this cell are unknown");
    }
    return out;
  }
}

/** No model. Returns the start of the context so a dry run shows what each baseline injected. */
export class EchoResponder implements Responder {
  readonly name = "echo";
  readonly simulated = true;

  async answer(context: string, question: string, _system?: string): Promise<Answered> {
    const preview = context.length > 600 ? `${context.slice(0, 600)}…` : context;
    const text = `SIMULATED — no model was called. Question: ${question}\nContext received (${context.length} chars, est. ${estimateTokens(context)} tokens):\n${preview || "(empty)"}`;
    return { text, ms: 0, simulated: true };
  }
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
