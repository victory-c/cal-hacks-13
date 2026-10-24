// HeuristicDistiller: the no-keys fallback, labelled simulated everywhere it shows up.
// Keyword-matched sentences stand in for a model's judgement so the whole pipeline (capture →
// distill → Jev → store → dashboard) runs on a laptop with an empty .env.

import type { CapturedSession, DraftFact, Folder } from "@canon/shared";
import type { Distiller, DistillResult } from "./index.ts";

const SIGNAL_RE = /\b(built|shipped|merged|decided|chose|prefer|deadline|targeting|applied|interview)\b/i;
const MAX_DRAFTS = 8;
const MAX_CHARS = 200;
// "Merged." matches the regex but carries nothing; a fact needs at least a few words.
const MIN_CHARS = 16;

// Order matters: the first group that matches wins.
const FOLDER_GUESSES: Array<[RegExp, Folder]> = [
  [/\b(resume|job|intern|internship|interns|recruit|recruiter|recruiting)\b/i, "career"],
  [/\b(repo|PR|code|hook|server)\b/i, "projects"],
  [/\bteam\b|\bwe decided\b/i, "team"],
];

export function guessFolder(sentence: string): Folder | undefined {
  for (const [re, folder] of FOLDER_GUESSES) if (re.test(sentence)) return folder;
  return undefined;
}

/** "I built X" → "Built X": the fact-file style is first person without the pronoun. */
function dropPronoun(s: string): string {
  const out = s.replace(/^(?:I|I've|I have|I'm|We|We've|We have)\s+/i, "");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export class HeuristicDistiller implements Distiller {
  readonly name = "heuristic" as const;

  async distill(session: CapturedSession): Promise<DistillResult> {
    const messages = session.messages.filter((m) => m.role === "user" || m.role === "assistant");
    const seen = new Set<string>();
    const drafts: DraftFact[] = [];
    let candidates = 0;

    for (const m of messages) {
      for (const raw of sentences(m.content)) {
        if (raw.length < MIN_CHARS || !SIGNAL_RE.test(raw)) continue;
        candidates++;
        const statement = dropPronoun(raw).slice(0, MAX_CHARS).trim();
        const key = statement.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (drafts.length >= MAX_DRAFTS) continue; // keep counting candidates for the plan line
        const folder = guessFolder(statement);
        const draft: DraftFact = { statement, source: sourceOf(session) };
        if (folder) draft.folder = folder;
        drafts.push(draft);
      }
    }

    return {
      drafts,
      plan: `heuristic: ${candidates} candidate sentences from ${messages.length} messages (simulated)`,
      simulated: true,
    };
  }
}

export function sourceOf(session: CapturedSession): DraftFact["source"] {
  const src: DraftFact["source"] = { client: session.client, session: session.id };
  if (session.meta?.pr) src.pr = session.meta.pr;
  if (session.meta?.url) src.url = session.meta.url;
  return src;
}
