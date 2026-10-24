// ClaudeJudge: the fallback when Jev is unavailable. Claude Haiku answers every question through
// one forced tool call ("answer"), so the output is structured JSON, never prose.
//
// Raw Messages API over fetch, because @canon/shared stays dependency-free. The request follows
// the claude-api skill: POST {base}/v1/messages with `x-api-key` and `anthropic-version`, one
// tool, and `tool_choice` forcing it. Claude Haiku 5.5 accepts a forced tool_choice (the
// response then starts with the tool call and skips thinking); Opus 5.5 / Sonnet 5.5 reject it,
// so keep this on Haiku. Content blocks are read by type, never by position.

import { env } from "../env.ts";
import type { Answer, Judge, Question } from "../types/judge.ts";
import { assembleAnswers, isRecord } from "./answers.ts";

const DEFAULT_MODEL = "claude-haiku-5-5";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2026-10-21";
const MAX_TOKENS = 1024;
const TIMEOUT_MS = 20_000;

const SYSTEM = `You are a calibrated judge inside Canon, a personal context store. You get a STATE (a fact, a task, candidate facts) and QUESTIONS, each with an id and a type.
Answer every question id exactly once by calling the "answer" tool, and do nothing else.
- noul: p is your probability that the answer is yes, in [0, 1]. Be calibrated: 0.5 means you truly do not know; avoid 0 and 1.
- choice: choice is exactly one of the listed options, copied verbatim; p is your probability that it is right. Optionally add distribution: option -> probability, summing to 1.
- score: value is a number within [min, max].`;

const ANSWER_TOOL = {
  name: "answer",
  description: "Report one answer per question id. Include every id from QUESTIONS.",
  input_schema: {
    type: "object",
    properties: {
      answers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "The question id" },
            p: { type: "number", description: "noul / choice: probability in [0, 1]" },
            choice: { type: "string", description: "choice: one of the options, verbatim" },
            value: { type: "number", description: "score: a number within [min, max]" },
            distribution: { type: "object", description: "choice, optional: option -> probability", additionalProperties: { type: "number" } },
          },
          required: ["id"],
        },
      },
    },
    required: ["answers"],
  },
} as const;

export class ClaudeJudge implements Judge {
  readonly name = "claude" as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    const apiKey = opts.apiKey ?? env("ANTHROPIC_API_KEY");
    if (!apiKey) throw new Error("ClaudeJudge: ANTHROPIC_API_KEY is not set. Put it in .env, or set JUDGE_PROVIDER=fake.");
    this.apiKey = apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    // Same override the official SDK honours. Tests point it at a local server.
    this.baseUrl = env("ANTHROPIC_BASE_URL", DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async ask(state: string, questions: Question[]): Promise<Answer[]> {
    if (questions.length === 0) return [];
    const body = {
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      tools: [ANSWER_TOOL],
      tool_choice: { type: "tool", name: ANSWER_TOOL.name },
      messages: [{ role: "user", content: `STATE:\n${state}\n\nQUESTIONS:\n${JSON.stringify(questions, null, 2)}` }],
    };
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": API_VERSION },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`ClaudeJudge: request to ${this.baseUrl} failed: ${errorMessage(err)}`, { cause: err });
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`ClaudeJudge: HTTP ${res.status}: ${apiErrorMessage(text)}`);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`ClaudeJudge: non-JSON response: ${text.slice(0, 300)}`);
    }
    return assembleAnswers("claude", questions, extractToolAnswers(json));
  }
}

function extractToolAnswers(json: unknown): unknown[] {
  if (!isRecord(json)) throw new Error("ClaudeJudge: response is not an object");
  if (json.stop_reason === "refusal") {
    const details = isRecord(json.stop_details) ? json.stop_details : {};
    throw new Error(`ClaudeJudge: Claude declined to answer (category: ${String(details.category ?? "unknown")})`);
  }
  if (json.stop_reason === "max_tokens") {
    console.warn(`[judge] claude: hit max_tokens=${MAX_TOKENS}; the answer list may be cut short`);
  }
  const content = Array.isArray(json.content) ? json.content : [];
  const tool = content.find((b): b is Record<string, unknown> => isRecord(b) && b.type === "tool_use" && b.name === ANSWER_TOOL.name);
  if (!tool || !isRecord(tool.input) || !Array.isArray(tool.input.answers)) {
    throw new Error(`ClaudeJudge: no "answer" tool call in the response (stop_reason: ${String(json.stop_reason)})`);
  }
  return tool.input.answers;
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
