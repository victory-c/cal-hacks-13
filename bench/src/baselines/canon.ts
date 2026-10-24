// The Canon baseline, end to end against a running server:
//   1. subscribe to /events, then POST each setup session as the "from" AI (its token)
//   2. wait until the distiller has filed facts for those sessions (or 60 s, then warn)
//   3. call canon_context(question) over MCP as the "to" AI (its token) and inject that slice
// Latency is the canon_context call alone; the capture + distill wait is reported in `detail`.

import { DEFAULT_BUDGET_TOKENS, DEFAULT_SERVER_URL, MCP_TOOLS, ROUTES, env, estimateTokens, nowIso, parseClientTokens, subscribeEvents, timed } from "@canon/shared";
import type { CapturedSession, ContextOutput } from "@canon/shared";

import { mcpToolCall } from "../mcp.ts";
import type { McpToolResult } from "../mcp.ts";
import type { BenchTask } from "../types.ts";
import type { Baseline, Prepared } from "./index.ts";

const DEFAULT_SETTLE_TIMEOUT_MS = 60_000;
// After every session has at least one fact and nothing new arrives for this long, assume the
// distiller is done. Only used when no distill.finished event tells us for sure.
const DEFAULT_QUIET_MS = 3_000;
// Events replayed to a new subscriber carry their original `at`; allow a little clock drift.
const CLOCK_SKEW_MS = 2_000;
// A server that accepts the socket but never sends the SSE headers would otherwise hang a run.
const DEFAULT_OPEN_TIMEOUT_MS = 10_000;

export interface CanonOptions {
  /** Defaults to CANON_URL, then http://localhost:4100. */
  serverUrl?: string;
  /** client → token. Defaults to CANON_CLIENT_TOKENS inverted. */
  tokens?: Map<string, string>;
  budgetTokens?: number;
  settleTimeoutMs?: number;
  quietMs?: number;
  fetch?: typeof fetch;
}

/** CANON_CLIENT_TOKENS (`client=token,…`) as client → token, the direction the bench needs. */
export function clientTokens(raw: string | undefined = env("CANON_CLIENT_TOKENS")): Map<string, string> {
  const byClient = new Map<string, string>();
  for (const [token, client] of parseClientTokens(raw)) byClient.set(client, token);
  return byClient;
}

export interface Settle {
  how: "distill.finished" | "quiet" | "timeout" | "stopped";
  ms: number;
  facts_saved: number;
  engines: string[];
  finished: string[];
}

/**
 * Watches /events for the distiller's work on `sessionIds`. Resolves `settled` when every session
 * has a distill.finished event, or when every session has a fact.saved and `quietMs` passes with
 * nothing new, or at `timeoutMs`. `opened` rejects fast when the stream cannot be opened at all.
 */
export function waitForDistill(
  eventsUrl: string,
  token: string,
  sessionIds: readonly string[],
  opts: { timeoutMs: number; quietMs: number; openTimeoutMs?: number },
): { opened: Promise<void>; settled: Promise<Settle>; stop: () => void } {
  const startedAt = Date.now();
  const pending = new Set(sessionIds);
  const withFact = new Set<string>();
  const engines = new Set<string>();
  const finished: string[] = [];
  let facts = 0;
  let done = false;
  let open = false;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let openTimer: ReturnType<typeof setTimeout> | undefined;

  let resolveSettled!: (s: Settle) => void;
  const settled = new Promise<Settle>((resolve) => (resolveSettled = resolve));
  let resolveOpened!: () => void;
  let rejectOpened!: (e: unknown) => void;
  const opened = new Promise<void>((resolve, reject) => {
    resolveOpened = resolve;
    rejectOpened = reject;
  });

  const finish = (how: Settle["how"]) => {
    if (done) return;
    done = true;
    clearTimeout(quietTimer);
    clearTimeout(timeoutTimer);
    clearTimeout(openTimer);
    unsubscribe();
    resolveSettled({ how, ms: Date.now() - startedAt, facts_saved: facts, engines: [...engines], finished });
  };

  const unsubscribe = subscribeEvents(
    eventsUrl,
    (e) => {
      // New subscribers get recent events replayed. An earlier run of this task used the same
      // session ids, so anything stamped before we started is history, not progress.
      if (Date.parse(e.at) < startedAt - CLOCK_SKEW_MS) return;
      switch (e.type) {
        case "distill.started":
          if (pending.has(e.session_id)) engines.add(e.engine);
          break;
        case "distill.finished":
          if (pending.has(e.session_id)) {
            pending.delete(e.session_id);
            finished.push(e.session_id);
            engines.add(e.engine);
            if (pending.size === 0) finish("distill.finished");
          }
          break;
        case "fact.saved": {
          const sid = e.fact.source.session;
          if (sessionIds.includes(sid)) {
            facts++;
            withFact.add(sid);
            if (withFact.size === sessionIds.length) {
              clearTimeout(quietTimer);
              quietTimer = setTimeout(() => finish("quiet"), opts.quietMs);
            }
          }
          break;
        }
        default:
          break;
      }
    },
    {
      headers: { authorization: `Bearer ${token}` },
      onOpen: () => {
        open = true;
        clearTimeout(openTimer);
        resolveOpened();
      },
      onError: (err) => {
        if (open || done) return;
        // Fail fast instead of retrying for a minute: the caller reports "server not reachable".
        rejectOpened(new Error(`Could not open the event stream at ${eventsUrl}: ${err instanceof Error ? err.message : String(err)}`));
        finish("stopped");
      },
    },
  );
  openTimer = setTimeout(() => {
    if (open || done) return;
    rejectOpened(new Error(`Event stream at ${eventsUrl} did not open within ${opts.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS} ms`));
    finish("stopped");
  }, opts.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS);
  timeoutTimer = setTimeout(() => finish("timeout"), opts.timeoutMs);
  // Callers that only await `settled` must not crash the process on an unhandled rejection.
  opened.catch(() => undefined);

  return { opened, settled, stop: () => finish("stopped") };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** structuredContent first, else the text block parsed as JSON. Facts without a statement are dropped. */
export function toContextOutput(result: McpToolResult): ContextOutput {
  let candidate: unknown = result.structured;
  if (candidate === undefined) {
    try {
      candidate = JSON.parse(result.text);
    } catch {
      candidate = undefined;
    }
  }
  if (!isRecord(candidate) || !Array.isArray(candidate.facts)) {
    throw new Error(`canon_context returned no ContextOutput (expected { facts: [...] }): ${result.text.slice(0, 300)}`);
  }
  const facts = candidate.facts.filter((f): f is ContextOutput["facts"][number] => isRecord(f) && typeof f.statement === "string");
  return {
    facts,
    tokens: typeof candidate.tokens === "number" ? candidate.tokens : estimateTokens(facts.map((f) => f.statement).join("\n")),
    latency_ms: typeof candidate.latency_ms === "number" ? candidate.latency_ms : 0,
    enough: candidate.enough !== false,
    ...(typeof candidate.missing === "string" ? { missing: candidate.missing } : {}),
    candidates: typeof candidate.candidates === "number" ? candidate.candidates : facts.length,
  };
}

/** The slice as the responder sees it. */
export function formatContext(output: ContextOutput): string {
  if (output.facts.length === 0) {
    return `Facts from Canon: none relevant to this task.${output.missing ? ` Missing: ${output.missing}` : ""}`;
  }
  const lines = output.facts.map((f) => {
    const head = `- ${f.statement} [${f.folder ?? "?"}, ${f.updated ?? "?"}]`;
    return f.detail ? `${head}\n  ${f.detail.replace(/\n/g, "\n  ")}` : head;
  });
  const note = output.enough ? "" : `\nCanon says this may not be enough${output.missing ? `: ${output.missing}` : "."}`;
  return `Facts from Canon (${output.facts.length} of ${output.candidates} candidates):\n${lines.join("\n")}${note}`;
}

export class CanonBaseline implements Baseline {
  readonly name = "canon" as const;
  private readonly serverUrl: string;
  private readonly tokens: Map<string, string>;
  private readonly budgetTokens: number;
  private readonly settleTimeoutMs: number;
  private readonly quietMs: number;
  private readonly doFetch: typeof fetch;

  constructor(opts: CanonOptions = {}) {
    this.serverUrl = (opts.serverUrl ?? env("CANON_URL", DEFAULT_SERVER_URL)).replace(/\/+$/, "");
    this.tokens = opts.tokens ?? clientTokens();
    this.budgetTokens = opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
    this.settleTimeoutMs = opts.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
    this.quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
    this.doFetch = opts.fetch ?? fetch;
  }

  private tokenFor(client: string): string {
    const token = this.tokens.get(client);
    if (!token) {
      const hint =
        this.tokens.size === 0
          ? "CANON_CLIENT_TOKENS is not set: copy .env.example to .env (it has dev tokens for every client)."
          : `Add "${client}=<token>" to CANON_CLIENT_TOKENS in .env; the server must know the same pair.`;
      throw new Error(`No token for client "${client}". ${hint}`);
    }
    return token;
  }

  private async health(): Promise<{ judge?: string; retriever?: string }> {
    const url = `${this.serverUrl}${ROUTES.health}`;
    let res: Response;
    try {
      res = await this.doFetch(url, { signal: AbortSignal.timeout(5000) });
    } catch (e) {
      throw new Error(`Canon server at ${this.serverUrl} is not reachable (${e instanceof Error ? e.message : String(e)}). Start it with "npm run dev -w server" or set CANON_URL.`, { cause: e });
    }
    if (!res.ok) throw new Error(`Canon server ${url} answered HTTP ${res.status}`);
    const json: unknown = await res.json().catch(() => ({}));
    return isRecord(json) ? { ...(typeof json.judge === "string" ? { judge: json.judge } : {}), ...(typeof json.retriever === "string" ? { retriever: json.retriever } : {}) } : {};
  }

  private async postSession(session: CapturedSession, token: string): Promise<void> {
    // ended_at tells the server the session is over, which triggers the final distill.
    const body: CapturedSession = { ...session, ended_at: session.ended_at ?? nowIso() };
    const url = `${this.serverUrl}${ROUTES.sessions}`;
    const res = await this.doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`POST ${url} for ${session.id} as ${session.client}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  async prepare(task: BenchTask): Promise<Prepared> {
    const fromToken = this.tokenFor(task.from_client);
    const toToken = this.tokenFor(task.to_client);
    const health = await this.health();
    const ids = task.setup_sessions.map((s) => s.id);

    const waiter = waitForDistill(`${this.serverUrl}${ROUTES.events}`, fromToken, ids, { timeoutMs: this.settleTimeoutMs, quietMs: this.quietMs });
    try {
      await waiter.opened;
      for (const session of task.setup_sessions) await this.postSession(session, fromToken);
    } catch (e) {
      waiter.stop();
      throw e;
    }
    const settle = await waiter.settled;
    if (settle.how === "timeout") {
      console.warn(`[bench] canon: no distill.finished for ${ids.join(", ")} within ${this.settleTimeoutMs} ms (${settle.facts_saved} facts seen); asking canon_context anyway`);
    }

    const { result, ms } = await timed(() =>
      mcpToolCall(`${this.serverUrl}${ROUTES.mcp}`, toToken, MCP_TOOLS.context, { task: task.question, budget_tokens: this.budgetTokens }, { fetch: this.doFetch }),
    );
    if (result.isError) throw new Error(`canon_context as ${task.to_client} failed: ${result.text || JSON.stringify(result.raw).slice(0, 300)}`);
    const output = toContextOutput(result);
    const context = formatContext(output);

    // A fake judge or a heuristic distiller means the slice was not chosen by the real pipeline.
    const simulated = health.judge === "fake" || settle.engines.includes("heuristic");
    return {
      context,
      tokens_injected_est: estimateTokens(context),
      latency_ms: ms,
      simulated,
      detail: {
        health,
        settle,
        canon_context: {
          tokens_est: output.tokens,
          latency_ms: output.latency_ms,
          candidates: output.candidates,
          enough: output.enough,
          ...(output.missing ? { missing: output.missing } : {}),
          fact_ids: output.facts.map((f) => f.id),
        },
      },
    };
  }
}
