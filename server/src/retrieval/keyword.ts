// KeywordRetriever: the offline stand-in for Moss. Lowercase tokens, stopwords dropped, score =
// share of query tokens found in the fact (statement + detail + folder path). Good enough to
// demo the pipeline with no credentials; it is labelled a stub everywhere it shows up.

import { folderAllows } from "@canon/shared";
import type { Fact, Folder } from "@canon/shared";

import type { RetrievalHit, Retriever } from "./index.ts";

const STOPWORDS = new Set(
  (
    "a an the and or but of to in on for with at by from is are was were be been being it its this that these those " +
    "i me my we our you your he she they them as do does did done what which who whom how can could should would will " +
    "about into not no so if then than up out over under have has had just also very any all some more most"
  ).split(" "),
);

/**
 * Distinct lowercase word tokens of length ≥ 2 that are not stopwords, each stemmed. `+`/`#`
 * survive for c++ and c#.
 */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().split(/[^a-z0-9+#]+/)) {
    if (t.length >= 2 && !STOPWORDS.has(t)) out.add(stem(t));
  }
  return out;
}

/**
 * A tiny suffix stripper so "internships" meets "internship", "shipped" meets "ship" and
 * "decided" meets "decide". Both the index and the query go through it, so it only has to be
 * consistent, not correct English; a stem is never cut below 4 characters. Tokens with digits
 * or symbols (c++, node22) are left alone.
 */
export function stem(token: string): string {
  if (!/^[a-z]+$/.test(token)) return token;
  let s = token;
  if (s.length >= 5 && s.endsWith("ies")) s = `${s.slice(0, -3)}y`;
  else if (s.length >= 6 && /(ss|sh|ch|x|z)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length >= 5 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  if (s.length >= 7 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length >= 6 && s.endsWith("ed")) s = s.slice(0, -2);
  if (/([^aeiou])\1$/.test(s) && !/(ll|ss|zz)$/.test(s)) s = s.slice(0, -1); // shipp → ship
  if (s.length >= 5 && s.endsWith("e")) s = s.slice(0, -1); // decide → decid, like decided
  return s;
}

export class KeywordRetriever implements Retriever {
  readonly name = "keyword";
  private entries: Array<{ fact: Fact; tokens: Set<string> }> = [];

  async index(facts: Fact[]): Promise<void> {
    this.entries = facts.map((fact) => ({
      fact,
      tokens: tokenize(`${fact.statement} ${fact.detail ?? ""} ${fact.folder.replaceAll("/", " ")}`),
    }));
  }

  async search(query: string, opts: { folders: readonly Folder[]; k: number }): Promise<RetrievalHit[]> {
    const q = tokenize(query);
    if (q.size === 0) return [];
    const hits: RetrievalHit[] = [];
    for (const e of this.entries) {
      if (!folderAllows(opts.folders, e.fact.folder)) continue;
      let matched = 0;
      for (const t of q) if (e.tokens.has(t)) matched++;
      if (matched > 0) hits.push({ fact: e.fact, score: matched / q.size });
    }
    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.fact.updated !== b.fact.updated) return a.fact.updated < b.fact.updated ? 1 : -1;
      return a.fact.id < b.fact.id ? -1 : 1;
    });
    return hits.slice(0, Math.max(0, opts.k));
  }
}
