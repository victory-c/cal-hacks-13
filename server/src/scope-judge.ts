// Scope-build and handoff questions for judge(), plus the simulated answers used when no model key is set.
//
// The question texts are deliberate, fixed formats: a real judge (Jev, Claude) reads each one as a
// self-contained yes/no question, and simulatedScopeAnswers() parses the same text to answer
// offline from keyword overlap — a labelled simulation, like the keyword retriever standing in for
// Moss. Any other question falls through to FakeJudge's own defaults, so triage and the MCP
// relevance filter are unchanged.

import { FakeJudge, createJudge } from "@canon/shared";
import type { Answer, Fact, Judge, Question } from "@canon/shared";

import { tokenize } from "./retrieval/keyword.ts";

/** Everything the judge may read about one fact: statement, detail, group and labels. */
export function factText(fact: Fact): string {
  return [fact.statement, fact.detail ?? "", fact.folder.replaceAll("/", " "), (fact.labels ?? []).join(" ")].join(" ").trim();
}

/** Scope build: does group g fall under the exclusion? Any real chance excludes the whole group. */
export function excludeGroupQ(id: string, groupId: string, description: string | undefined, excludeText: string): Question {
  return { id, type: "noul", text: `Exclusion: «${excludeText}». Does this group fall under it? Group ${groupId}: ${description ?? ""}`.trimEnd() };
}

/** Scope build / live update: does this fact fall under the exclusion? A maybe counts as excluded. */
export function excludeFactQ(id: string, fact: Fact, excludeText: string): Question {
  return { id, type: "noul", text: `Exclusion: «${excludeText}». Does this fact fall under it? Fact ${fact.id}: ${factText(fact)}` };
}

/** Scope build / live update: does this fact help with the principal's task? A yes joins the scope. */
export function inScopeQ(id: string, fact: Fact, task: string): Question {
  return { id, type: "noul", text: `Task: «${task}». Does this fact help with it? Fact ${fact.id}: ${factText(fact)}` };
}

/** Handoff: does answering this request need any stored context at all? Below the bar, only the pinned profile goes out. */
export function needsContextQ(id: string, request: string): Question {
  return { id, type: "noul", text: `Request: «${request}». Does answering it need any stored context at all?` };
}

/** Handoff: does this fact help answer the request? The yes answers compete for the token budget. */
export function helpsRequestQ(id: string, fact: Fact, request: string): Question {
  return { id, type: "noul", text: `Request: «${request}». Does this fact help answer it? Fact ${fact.id}: ${factText(fact)}` };
}

// The subject starts after the "Group "/"Fact " marker, so an exclusion that merely contains the
// word "fact" or "group" never matches every question.
const EXCLUDE_RE = /^Exclusion: «([\s\S]*)»\. Does this (?:group|fact) fall under it\? (?:Group|Fact) ([\s\S]*)$/;
const HELP_RE = /^Task: «([\s\S]*)»\. Does this fact help with it\? Fact ([\s\S]*)$/;
const NEEDS_RE = /^Request: «([\s\S]*)»\. Does answering it need any stored context at all\?$/;
const HELPS_REQUEST_RE = /^Request: «([\s\S]*)»\. Does this fact help answer it\? Fact ([\s\S]*)$/;

/**
 * Share of the query's word tokens found in the subject. Pure-digit tokens are ignored: every
 * fact and task carries dates, and "2026" matching "2026" says nothing about relevance.
 */
function overlap(query: string, subject: string): number {
  const q = [...tokenize(query)].filter((t) => !/^\d+$/.test(t));
  if (q.length === 0) return 0;
  const s = tokenize(subject);
  let matched = 0;
  for (const t of q) if (s.has(t)) matched++;
  return matched / q.length;
}

/**
 * Deterministic, offline stand-in for Jev on the scope and handoff questions above (FakeJudge
 * `override`). Cautious on exclusions: any keyword overlap with the exclusion text clears the
 * "any real chance" bar. Relevance: any overlap with the task clears IN_SCOPE; none stays well
 * below it. Needs-context: the handoff passes the candidate statements as `state`, so a request
 * that overlaps nothing stored is answered "no context needed".
 */
export function simulatedScopeAnswers(q: Question, state: string): Answer | undefined {
  if (q.type !== "noul") return undefined;
  const excluded = EXCLUDE_RE.exec(q.text);
  if (excluded) {
    const share = overlap(excluded[1], excluded[2]);
    return { id: q.id, type: "noul", p: share > 0 ? Math.min(0.95, 0.6 + 0.35 * share) : 0.05 };
  }
  const helps = HELP_RE.exec(q.text) ?? HELPS_REQUEST_RE.exec(q.text);
  if (helps) {
    const share = overlap(helps[1], helps[2]);
    return { id: q.id, type: "noul", p: share > 0 ? Math.min(0.95, 0.7 + 0.25 * share) : 0.1 };
  }
  const needs = NEEDS_RE.exec(q.text);
  if (needs) {
    return { id: q.id, type: "noul", p: overlap(needs[1], state) > 0 ? 0.9 : 0.1 };
  }
  return undefined;
}

/**
 * The server's judge: the usual provider chain (Jev → Claude → fake, see createJudge()), with the
 * fake upgraded to answer scope-build questions from keyword overlap instead of canned keywords,
 * so the offline demo builds sensible scopes. Still fully simulated and labelled as such — the
 * name stays "fake" and GET /health reports it.
 */
export function createServerJudge(): Judge {
  const judge = createJudge();
  if (judge.name !== "fake") return judge;
  return new FakeJudge({ override: simulatedScopeAnswers });
}
