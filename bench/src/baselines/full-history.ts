// "Paste the whole history": every setup session, every message, in order. This is what people
// do by hand today, and it is the token ceiling Canon is measured against.

import { estimateTokens } from "@canon/shared";
import type { CapturedSession } from "@canon/shared";

import type { BenchTask } from "../types.ts";
import type { Baseline, Prepared } from "./index.ts";

/** Plain-text transcript. Exported so the token-accounting test can check it byte for byte. */
export function transcript(sessions: CapturedSession[]): string {
  return sessions
    .map((s) => {
      const head = `## Session ${s.id} — ${s.client}${s.title ? `: ${s.title}` : ""} (${s.started_at})`;
      return [head, ...s.messages.map((m) => `${m.role}: ${m.content}`)].join("\n");
    })
    .join("\n\n");
}

export class FullHistoryBaseline implements Baseline {
  readonly name = "full-history" as const;

  async prepare(task: BenchTask): Promise<Prepared> {
    const t0 = performance.now();
    const context = transcript(task.setup_sessions);
    return {
      context,
      tokens_injected_est: estimateTokens(context),
      latency_ms: Math.round(performance.now() - t0),
      detail: { sessions: task.setup_sessions.length, messages: task.setup_sessions.reduce((n, s) => n + s.messages.length, 0) },
    };
  }
}
