// The floor: a brand-new session that knows nothing about the user.

import type { BenchTask } from "../types.ts";
import type { Baseline, Prepared } from "./index.ts";

export class NoMemoryBaseline implements Baseline {
  readonly name = "no-memory" as const;

  async prepare(_task: BenchTask): Promise<Prepared> {
    return { context: "", tokens_injected_est: 0, latency_ms: 0 };
  }
}
