// Bench-local types. The task file format lives here (mirrored in ../tasks/task.schema.json for
// editors and for Edan); everything server-facing comes from @canon/shared.

import type { CapturedSession, ClientId, Folder } from "@canon/shared";

export interface AnswerKey {
  /** Every phrase must appear in the answer (case-insensitive substring). */
  must_include: string[];
  /** None of these may appear. Catches leaks from private/ and confident wrong guesses. */
  must_not_include?: string[];
}

/** One handoff: context created in `from_client`, a question asked in `to_client`. */
export interface BenchTask {
  /** Equals the file name without .json, e.g. "t01-internship-headline". */
  id: string;
  title: string;
  /** The AI where the context was created. Setup sessions are posted with this client's token. */
  from_client: ClientId;
  /** The AI where the question is asked. canon_context runs with this client's token. */
  to_client: ClientId;
  /** Where the facts are expected to land. The to_client must be granted it. */
  folder: Folder;
  setup_sessions: CapturedSession[];
  question: string;
  answer_key: AnswerKey;
  notes?: string;
}

export interface ScoreResult {
  /** Every must_include hit and no must_not_include violated. */
  correct: boolean;
  hits: string[];
  misses: string[];
  violations: string[];
}
