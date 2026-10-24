// Save-time Jev decisions (CLAUDE.md "Jev decisions" table). Given the engine's drafts and the
// hot facts already in the store, ask Jev the typed questions for EVERY draft in ONE request,
// then apply THRESHOLDS ourselves. Pure given a Judge: no I/O, no env, deterministic with FakeJudge.
//
// v1. The worker now runs the scopes triage (triage.ts: groups, labels, quarantine, inbox), which
// reuses this file's exact-duplicate rule through normalizeStatement().

import { INBOX, THRESHOLDS, TOP_FOLDERS, newFactId, today } from "@canon/shared";
import type { Answer, DraftFact, Fact, Folder, Judge, Question, SaveAction, SaveDecision } from "@canon/shared";

export interface Decided {
  fact: Fact;
  decision: SaveDecision;
}

const DUPE_OPTIONS = ["new", "duplicate", "supersedes"] as const;
const NONE = "none";
/** Keeps the state small: Jev sees the most recent hot facts, not the whole store. */
const MAX_EXISTING = 40;

export async function decideFacts(drafts: DraftFact[], existingHot: Fact[], judge: Judge): Promise<Decided[]> {
  if (drafts.length === 0) return [];
  const existing = existingHot.slice(-MAX_EXISTING);
  const existingIds = existing.map((f) => f.id);
  // A draft that repeats an existing hot fact word for word is a duplicate whatever the judge
  // says (a re-distilled or replayed session must merge into what it already produced, never
  // file a second copy). Scans the whole store, not only the 40 the judge sees; last one wins.
  const byStatement = new Map<string, string>();
  for (const f of existingHot) {
    const key = normalizeStatement(f.statement);
    if (key) byStatement.set(key, f.id);
  }

  const state = JSON.stringify(
    {
      drafts: drafts.map((d, i) => ({ i, statement: d.statement, suggested_folder: d.folder, detail: d.detail })),
      existing_hot_facts: existing.map((f) => ({ id: f.id, statement: f.statement })),
    },
    null,
    1,
  );

  const questions: Question[] = drafts.flatMap((d, i) => buildQuestions(d, i, existingIds));
  // The one-batched-request rule: one state, all drafts' questions, exactly one ask().
  const answers = await judge.ask(state, questions);
  const byId = new Map(answers.map((a) => [a.id, a]));

  return drafts.map((draft, i) => apply(draft, i, byId, existingIds, judge, byStatement.get(normalizeStatement(draft.statement))));
}

/** Lowercase, letters and digits only, single spaces: "Prefer TS." equals "prefer  ts". */
export function normalizeStatement(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function buildQuestions(d: DraftFact, i: number, existingIds: string[]): Question[] {
  // The engine's suggestion leads the list (a subfolder like career/projects is an option too),
  // then the top folders. Order matters to a neutral judge and reads better in the question.
  const folderOptions: string[] = d.folder ? [d.folder, ...TOP_FOLDERS.filter((f) => f !== d.folder)] : [...TOP_FOLDERS];
  const quoted = `Draft ${i}: "${d.statement}"`;
  return [
    { id: `keep:${i}`, type: "noul", text: `${quoted} — worth keeping hot?` },
    { id: `folder:${i}`, type: "choice", text: `${quoted} — which folder?`, options: folderOptions },
    { id: `dupe:${i}`, type: "choice", text: `${quoted} — new, duplicate of an existing hot fact, or supersedes one?`, options: [...DUPE_OPTIONS] },
    { id: `which:${i}`, type: "choice", text: `${quoted} — which existing fact does it duplicate or supersede?`, options: [...existingIds, NONE] },
  ];
}

function apply(draft: DraftFact, i: number, byId: Map<string, Answer>, existingIds: string[], judge: Judge, exactDupe?: string): Decided {
  const keep = byId.get(`keep:${i}`);
  const folder = byId.get(`folder:${i}`);
  const dupe = byId.get(`dupe:${i}`);
  const which = byId.get(`which:${i}`);

  // A missing answer is "I don't know": 0.5 keeps the fact cold, no folder sends it to the inbox.
  const keep_p = keep?.type === "noul" ? keep.p : 0.5;
  const folder_p = folder?.type === "choice" ? folder.p : 0;
  const chosenFolder = folder?.type === "choice" ? (folder.choice as Folder) : undefined;
  const dupeChoice = dupe?.type === "choice" ? dupe.choice : "new";
  const whichChoice = which?.type === "choice" ? which.choice : NONE;

  const tier = keep_p > THRESHOLDS.KEEP_HOT ? "hot" : "cold";
  const finalFolder: Folder = chosenFolder && folder_p >= THRESHOLDS.FOLDER_CONFIDENT ? chosenFolder : INBOX;

  // "duplicate"/"supersedes" only mean something when Jev named a real existing fact. An exact
  // duplicate (see decideFacts) is a merge into that fact no matter what Jev answered.
  let target = whichChoice !== NONE && existingIds.includes(whichChoice) ? whichChoice : undefined;
  let action: SaveAction = "add";
  if (exactDupe) {
    action = "merge";
    target = exactDupe;
  } else if (target && dupeChoice === "duplicate") action = "merge";
  else if (target && dupeChoice === "supersedes") action = "supersede";

  const fact: Fact = {
    id: newFactId(),
    statement: draft.statement,
    folder: finalFolder,
    tier,
    jev_keep: keep_p,
    source: draft.source,
    updated: today(),
  };
  // Both merge and supersede retire the old fact in favour of this one (never a delete).
  if (action !== "add" && target) fact.supersedes = target;
  if (draft.detail) fact.detail = draft.detail;

  const decision: SaveDecision = { tier, folder: finalFolder, action, keep_p, folder_p, judge: judge.name };
  if (action !== "add" && target) decision.supersedes = target;

  return { fact, decision };
}
