// Token accounting for the budget cut and the dashboard counter.
//
// `estimateTokens` is a ~4 chars/token estimate. Label it "est." wherever it is shown.
// Real counts come from a model's `usage` field (the benchmark records those).

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface Sized {
  statement: string;
  detail?: string;
}

export function factTokens(f: Sized): number {
  return estimateTokens(f.statement) + (f.detail ? estimateTokens(f.detail) : 0);
}

/** Keeps items in order until the next one would exceed the budget. */
export function cutToBudget<T extends Sized>(items: readonly T[], budget: number): { kept: T[]; tokens: number } {
  const kept: T[] = [];
  let tokens = 0;
  for (const item of items) {
    const cost = factTokens(item);
    if (tokens + cost > budget) break;
    kept.push(item);
    tokens += cost;
  }
  return { kept, tokens };
}
