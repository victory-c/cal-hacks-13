// The "vs full history" slot on the counter. Its number comes only from a benchmark run: lane A's
// `npm run run -w bench` writes bench/results/latest.json (+ chart.json), and web/scripts/serve.mjs
// serves that folder same-origin under /bench/. The Canon server has no part in it (no /bench
// route, nothing in ROUTES). No file → "run bench". We never hard-code a comparison (CLAUDE.md:
// never invent numbers), and a file written from a simulated run says so on the counter.
//
// Shapes read (bench/src/results.ts): the Summary in latest.json (`baselines: [{ baseline,
// mean_input_tokens, mean_tokens_injected_est, … }]`, `tasks`, `simulated`) and the Chart in
// chart.json (`series: [{ baseline, tokens, … }]`, `simulated`). Real `usage` tokens win over the
// `*_est` figure. The older guesses (baselines as an object, `tokens`-like fields) still work,
// and anything else gives up loudly ("bench format?") rather than guessing.

/** Same-origin path of the bench summary; serve.mjs maps /bench/ to <repo>/bench/results/. */
export const BENCH_URL = "bench/latest.json";

export interface BenchComparison {
  canonTokens: number;
  fullTokens: number;
  /** Canon uses this many times fewer tokens than pasting the full history. */
  ratio: number;
  tasks?: number;
  /** The run's own `simulated` flag: a stub stood in somewhere, so the figure is not quotable. */
  simulated?: boolean;
}

export type BenchResult =
  | { status: "ok"; comparison: BenchComparison }
  | { status: "missing" }
  | { status: "unreadable" }
  | { status: "offline" };

// Order matters: the model's real usage first, the ~4 chars/token estimate last.
const TOKEN_FIELDS = ["mean_input_tokens", "tokens", "tokens_injected", "avg_tokens", "mean_tokens", "tokens_mean", "tokens_avg", "avg_tokens_injected", "mean_tokens_injected_est"];

type Dict = Record<string, unknown>;
const isDict = (x: unknown): x is Dict => typeof x === "object" && x !== null && !Array.isArray(x);

export async function fetchBench(url: string = BENCH_URL, fetchFn: typeof fetch = fetch): Promise<BenchResult> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { accept: "application/json" } });
  } catch {
    return { status: "offline" };
  }
  if (res.status === 404) return { status: "missing" };
  if (!res.ok) return { status: "unreadable" };
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return { status: "unreadable" };
  }
  const comparison = pickBenchComparison(json);
  return comparison ? { status: "ok", comparison } : { status: "unreadable" };
}

/** Text for the counter slot. */
export function benchText(r: BenchResult | undefined): string {
  if (!r) return "—";
  switch (r.status) {
    case "ok": {
      const { ratio, tasks, simulated } = r.comparison;
      const x = ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1);
      return `${x}× fewer tokens${tasks ? ` · ${tasks} tasks` : ""}${simulated ? " (simulated)" : ""}`;
    }
    case "missing":
      return "— (run bench)";
    case "unreadable":
      return "— (bench format?)";
    case "offline":
      return "—";
  }
}

/** Finds the Canon and full-history token figures in a bench results document, or null. */
export function pickBenchComparison(json: unknown): BenchComparison | null {
  if (!isDict(json)) return null;
  const baselines = collectBaselines(json);
  const canon = baselines.get("canon");
  const full = baselines.get("full");
  if (canon === undefined || full === undefined || full <= 0 || canon < 0) return null;
  const out: BenchComparison = { canonTokens: canon, fullTokens: full, ratio: canon === 0 ? Infinity : full / canon };
  const tasks = countTasks(json);
  if (tasks) out.tasks = tasks;
  if (json.simulated === true) out.simulated = true;
  return out;
}

/** Returns a map of normalized baseline name ("canon" | "full" | other) → tokens. */
function collectBaselines(doc: Dict): Map<string, number> {
  const out = new Map<string, number>();
  const candidates: unknown[] = [doc.baselines, doc.series, doc.results, doc.summary, doc];
  for (const c of candidates) {
    if (Array.isArray(c)) {
      for (const item of c) {
        if (!isDict(item)) continue;
        const name = normalizeName(item.name ?? item.baseline ?? item.mode ?? item.id);
        const tokens = readTokens(item);
        if (name && tokens !== undefined && !out.has(name)) out.set(name, tokens);
      }
    } else if (isDict(c)) {
      for (const [key, value] of Object.entries(c)) {
        const name = normalizeName(key);
        if (!name || !isDict(value)) continue;
        const tokens = readTokens(value);
        if (tokens !== undefined && !out.has(name)) out.set(name, tokens);
      }
    }
    if (out.has("canon") && out.has("full")) break;
  }
  return out;
}

function normalizeName(x: unknown): string | null {
  if (typeof x !== "string") return null;
  const n = x.toLowerCase().replace(/[^a-z]/g, "");
  if (n === "canon") return "canon";
  if (n.includes("full") || n.includes("paste") || n === "history") return "full";
  if (n.includes("nomemory") || n === "none" || n === "baseline") return "none";
  return n || null;
}

function readTokens(item: Dict): number | undefined {
  for (const f of TOKEN_FIELDS) {
    const v = item[f];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (isDict(v)) {
      for (const inner of ["mean", "avg", "average", "total"]) {
        const n = v[inner];
        if (typeof n === "number" && Number.isFinite(n)) return n;
      }
    }
  }
  return undefined;
}

function countTasks(doc: Dict): number | undefined {
  const t = doc.tasks;
  if (typeof t === "number" && t > 0) return t;
  if (Array.isArray(t) && t.length > 0) return t.length;
  for (const k of ["task_count", "n_tasks", "n"]) {
    const v = doc[k];
    if (typeof v === "number" && v > 0) return v;
  }
  return undefined;
}
