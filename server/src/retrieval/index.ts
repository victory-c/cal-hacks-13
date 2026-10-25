// Retriever: the candidate generator behind canon_context and canon_search (task A4).
// The app indexes the hot facts and re-indexes on every fact.saved / fact.retired, so a
// retriever only has to answer "which of these facts look like this query". Jev does the
// real relevance filtering afterwards.

import { env } from "@canon/shared";
import type { Fact, Folder } from "@canon/shared";

import { KeywordRetriever } from "./keyword.ts";
import { MossRetriever } from "./moss.ts";

export interface RetrievalHit {
  fact: Fact;
  /** Retriever-specific, higher is better. Not a probability; Jev's answer is. */
  score: number;
}

export interface Retriever {
  readonly name: string;
  close?(): Promise<void>;
  /** Replaces the index with these facts. */
  index(facts: Fact[]): Promise<void>;
  /** Top `k` hits whose folder is granted (folderAllows semantics). */
  search(query: string, opts: { folders: readonly Folder[]; k: number }): Promise<RetrievalHit[]>;
}

/** Moss when its credentials are set, else the keyword stub. Logs which one. */
export function createRetriever(): Retriever {
  if (env("MOSS_PROJECT_ID") && env("MOSS_PROJECT_KEY")) {
    console.info("[retrieval] provider: moss (local semantic + keyword index)");
    return new MossRetriever();
  }
  console.info("[retrieval] provider: keyword (stub, simulated relevance; Moss lands in task A4)");
  return new KeywordRetriever();
}

export { KeywordRetriever, MossRetriever };
