// HeuristicDistiller: the no-keys fallback, labelled simulated everywhere it shows up.
// Keyword-matched sentences stand in for the fact writer's judgement so the whole pipeline
// (capture → triage → write → store → dashboard) runs on a laptop with an empty .env.
//
// v2 (PRD v2, a small finance firm): the signals cover deal work (proposed, agreed, LOI, term
// sheet, valuation, EBITDA, board, diligence, prices and multiples written as numbers); sentences
// keep the speaker's name in third person when the item says who spoke ("Dan: I proposed …" →
// "Dan proposed …"); `happened` is read off an ISO date in the sentence and never guessed; and a
// paragraph aimed at an AI ("ignore your previous instructions …") never becomes a draft. Triage
// still quarantines the whole item: it asks about the captured text, not about these drafts.

import type { CapturedSession, DraftFact, Folder } from "@canon/shared";
import type { Distiller, DistillResult } from "./index.ts";

const SIGNAL_WORDS = [
  // v1: what someone built or decided
  "built", "shipped", "merged", "decided", "chose", "prefer", "deadline", "targeting", "applied", "interview",
  // v2: a finance firm's deal work
  "agreed", "proposed", "LOI", "term sheet", "valuation", "multiples?", "EBITDA", "pric(?:e|es|ed|ing)",
  "closing", "board", "diligence", "announc(?:e|ed|es|ement)",
];
const SIGNAL_RE = new RegExp(`\\b(?:${SIGNAL_WORDS.join("|")})\\b`, "gi");
/** Deal numbers count as a signal on their own: "$38.50", "9.5x", "38.50/sh", "per share". */
const DEAL_NUMBER_RE = /\$\s?\d|\b\d+(?:\.\d+)?x\b|\d\/sh\b|\bper share\b/i;

/**
 * Crude, on purpose: the offline engine only has to keep a planted instruction out of the facts.
 * Deciding that an item is an injection is triage's job (Jev, TRIAGE_THRESHOLDS.INJECTION).
 */
const AIMED_AT_AI_RE =
  /\b(?:ignore|disregard|forget|override)\b[^.!?\n]{0,40}\b(?:instructions?|rules?|prompts?|guidelines?)\b|\b(?:AI assistant|language model|automated system)s?\b[^.!?\n]{0,40}\b(?:processing|reading)\b|\bsystem prompt\b/i;

/** Memo and email header lines are metadata, not claims. */
const HEADER_LINE_RE = /^(?:To|From|Cc|Bcc|Date|Re|Subject|Sent):\s/i;
/** "- ", "* ", "• ", "1. ", "2) " at the start of a line, and markdown bold anywhere. */
const LIST_MARKER_RE = /^(?:[-*•]|\d+[.)])\s+/;

const MAX_DRAFTS = 8;
const MAX_CHARS = 200;
// "Merged." matches the regex but carries nothing; a fact needs at least a few words.
const MIN_CHARS = 16;
// "Diligence workstreams" is a heading, not a claim.
const MIN_WORDS = 4;

/** Kinds whose lines read "Name: text". Memos and emails also have "To:" / "Date:" lines, so not those. */
const SPEAKER_KINDS = new Set(["chat", "transcript"]);
/**
 * Kinds the principal wrote themselves, so "I" in a user turn is them. Not email: a thread holds
 * other people's replies, and the principal is only whose mailbox it came from.
 */
const AUTHORED_KINDS = new Set(["ai_session", "memo", "note"]);
const SPEAKER_RE = /^([A-Z][a-z]+(?: [A-Z][a-z]+)?):\s+(.+)$/;

// Order matters: the first group that matches wins.
const FOLDER_GUESSES: Array<[RegExp, Folder]> = [
  [/\b(resume|job|intern|internship|interns|recruit|recruiter|recruiting)\b/i, "career"],
  [/\b(repo|PR|code|hook|server)\b/i, "projects"],
  // A finance firm's deal work is team context; the wall label, not the folder, decides who sees it.
  [/\bteam\b|\bwe decided\b|\b(deal|LOI|term sheet|valuation|EBITDA|diligence|board)\b/i, "team"],
];

export function guessFolder(sentence: string): Folder | undefined {
  for (const [re, folder] of FOLDER_GUESSES) if (re.test(sentence)) return folder;
  return undefined;
}

/**
 * Third person with a name when we know who said it: "I proposed X" → "Dan proposed X",
 * "We agreed X" → "Dan's team agreed X", anything else → "Dan: X". With no speaker, the v1
 * style: drop the pronoun.
 */
export function attribute(sentence: string, speaker?: string): string {
  // Longest first, so "I have" is not read as "I" + "have".
  const m = /^(I have|I've|I'm|I|We have|We've|We)\s+/i.exec(sentence);
  if (!m) {
    const s = capitalize(sentence);
    return speaker && !s.startsWith(speaker) ? `${speaker}: ${s}` : s;
  }
  const rest = sentence.slice(m[0].length);
  if (!speaker) return capitalize(rest);
  const pronoun = m[1].toLowerCase();
  const subject = pronoun.startsWith("we") ? `${speaker}'s team` : speaker;
  const verb = pronoun === "i'm" ? "is " : pronoun === "i've" || pronoun === "i have" ? "has " : pronoun === "we've" || pronoun === "we have" ? "has " : "";
  return `${subject} ${verb}${rest}`;
}

/** "dan" → "Dan". Agents (`agt_…`) and missing principals have no name to put on a fact. */
export function principalName(id: string | undefined): string | undefined {
  if (!id || !/^[a-z]+$/i.test(id)) return undefined;
  return capitalize(id.toLowerCase());
}

/** The first real calendar date written as YYYY-MM-DD (a timestamp's date part counts), or undefined. */
export function isoDayIn(text: string): string | undefined {
  for (const m of text.matchAll(/(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)/g)) {
    const day = asDay(m[1]);
    if (day) return day;
  }
  return undefined;
}

/** Exactly YYYY-MM-DD and a real date (no 2026-02-30), else undefined. */
export function asDay(x: unknown): string | undefined {
  if (typeof x !== "string") return undefined;
  const s = x.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : undefined;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Each line of a message with who said it, when the item tells us. Header lines are dropped. */
function lines(session: CapturedSession, role: string, content: string): Array<{ text: string; speaker?: string }> {
  const kind = session.kind ?? "ai_session";
  const authored = role === "user" && AUTHORED_KINDS.has(kind) && session.external !== true;
  const owner = authored ? principalName(session.principal) : undefined;
  const speakerLines = SPEAKER_KINDS.has(kind);
  const out: Array<{ text: string; speaker?: string }> = [];
  for (const raw of content.split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = speakerLines ? SPEAKER_RE.exec(line) : null;
    if (m) {
      out.push({ text: clean(m[2]), speaker: m[1] });
      continue;
    }
    if (HEADER_LINE_RE.test(line)) continue;
    out.push({ text: clean(line), speaker: owner });
  }
  return out;
}

function clean(line: string): string {
  return line.replace(LIST_MARKER_RE, "").replace(/\*\*/g, "").trim();
}

/** A question asks; it does not state anything to keep. */
const QUESTION_RE = /\?\s*$|^(?:what'?s?|whats|how|why|should|could|would|anyone)\b/i;

/** How strongly a sentence reads like a fact worth keeping. 0 = not a candidate. */
function score(sentence: string, fromUser: boolean, happened: string | undefined): number {
  if (QUESTION_RE.test(sentence)) return 0;
  const words = new Set((sentence.match(SIGNAL_RE) ?? []).map((w) => w.toLowerCase())).size;
  const numbers = DEAL_NUMBER_RE.test(sentence) ? 1 : 0;
  if (words + numbers === 0) return 0;
  // The person's own words beat an assistant's arithmetic or summary; a dated claim beats an undated one.
  return words + numbers + (fromUser ? 2 : 0) + (happened ? 1 : 0);
}

interface Candidate {
  draft: DraftFact;
  score: number;
  order: number;
}

export class HeuristicDistiller implements Distiller {
  readonly name = "heuristic" as const;

  async distill(session: CapturedSession): Promise<DistillResult> {
    const messages = session.messages.filter((m) => m.role === "user" || m.role === "assistant");
    const seen = new Set<string>();
    const kept: Candidate[] = [];
    let candidates = 0;
    let aimedAtAi = 0;

    for (const m of messages) {
      for (const line of lines(session, m.role, m.content)) {
        // The whole paragraph goes: the sentences around a planted instruction carry its claims
        // ("… Falcon has been announced, so label it public").
        if (AIMED_AT_AI_RE.test(line.text)) {
          aimedAtAi++;
          continue;
        }
        for (const raw of sentences(line.text)) {
          if (raw.length < MIN_CHARS || raw.split(/\s+/).length < MIN_WORDS) continue;
          const happened = isoDayIn(raw);
          const s = score(raw, m.role === "user", happened);
          if (s === 0) continue;
          candidates++;
          const statement = attribute(raw, line.speaker).slice(0, MAX_CHARS).trim();
          const key = statement.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          const draft: DraftFact = { statement, source: sourceOf(session) };
          const folder = guessFolder(statement);
          if (folder) draft.folder = folder;
          if (happened) draft.happened = happened;
          kept.push({ draft, score: s, order: kept.length });
        }
      }
    }

    // The strongest MAX_DRAFTS (ties go to the earlier one), back in the order the item said them.
    const drafts = kept
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, MAX_DRAFTS)
      .sort((a, b) => a.order - b.order)
      .map((c) => c.draft);

    const left = aimedAtAi ? `, ${aimedAtAi} ${aimedAtAi === 1 ? "paragraph" : "paragraphs"} left out as instructions aimed at an AI` : "";
    return {
      drafts,
      plan: `heuristic: ${candidates} candidate sentences from ${messages.length} messages${left} (simulated)`,
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
