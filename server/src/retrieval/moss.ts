// MossRetriever: the real retrieval layer (sponsor track), task A4. NOT IMPLEMENTED YET.
//
// This file is the one place Moss plugs in. The SDK's API is unknown until the credentials and
// docs arrive (blocker Q2), so nothing below guesses at it: the constructor refuses to run
// without MOSS_PROJECT_ID / MOSS_PROJECT_KEY and every method throws "not implemented".
// Replace the bodies, keep the shape, and createRetriever() picks it up with no other change.

import { env } from "@canon/shared";
import type { Fact, Folder } from "@canon/shared";

import type { RetrievalHit, Retriever } from "./index.ts";

export class MossRetriever implements Retriever {
  readonly name = "moss";

  constructor() {
    if (!env("MOSS_PROJECT_ID") || !env("MOSS_PROJECT_KEY")) {
      throw new Error("Moss not wired yet — task A4, needs credentials (blocker Q2). Set MOSS_PROJECT_ID and MOSS_PROJECT_KEY, or unset them to use the keyword stub.");
    }
  }

  async index(_facts: Fact[]): Promise<void> {
    throw new Error("MossRetriever.index: not implemented (task A4)");
  }

  async search(_query: string, _opts: { folders: readonly Folder[]; k: number }): Promise<RetrievalHit[]> {
    throw new Error("MossRetriever.search: not implemented (task A4)");
  }
}
