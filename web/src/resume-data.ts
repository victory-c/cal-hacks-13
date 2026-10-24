// Resume viewer data: groups hot `career/*` facts by subfolder and renders them as markdown.
// Pure (no DOM, no fetch) so it runs under node:test. No LLM here: the resume is the facts
// themselves, each line naming the client and session it came from. Resume writing is a later task.

import { ROUTES } from "@canon/shared";
import type { Fact } from "@canon/shared";

import { folderSub, folderTop } from "./format.ts";

export interface ResumeGroup {
  /** Subfolder under career/, or "general" for facts filed at career/ itself. */
  key: string;
  title: string;
  facts: Fact[];
}

/** Sections people expect first; anything else follows alphabetically. */
const SECTION_ORDER = ["summary", "experience", "projects", "skills", "education", "general"];

export function groupCareerFacts(facts: readonly Fact[]): ResumeGroup[] {
  const groups = new Map<string, Fact[]>();
  for (const f of facts) {
    // The server filters by ?folder=career&tier=hot; this guards a stale or permissive response.
    if (folderTop(f.folder) !== "career" || f.tier !== "hot") continue;
    const key = folderSub(f.folder) || "general";
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }
  const rank = (k: string) => {
    const i = SECTION_ORDER.indexOf(k);
    return i < 0 ? SECTION_ORDER.length : i;
  };
  return Array.from(groups.entries())
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([key, list]) => ({
      key,
      title: titleCase(key),
      facts: list.slice().sort((x, y) => (x.updated < y.updated ? 1 : x.updated > y.updated ? -1 : x.statement.localeCompare(y.statement))),
    }));
}

/**
 * Where a fact's source session can be read back: GET /api/sessions/:id on the server. That route
 * needs a bearer token (server/src/router.ts), which a browser navigation cannot send, so the
 * viewer and the markdown show the session id instead of linking here. For token-holding callers.
 */
export function sessionUrl(server: string, sessionId: string): string {
  return `${server}${ROUTES.sessions}/${encodeURIComponent(sessionId)}`;
}

export function resumeMarkdown(groups: readonly ResumeGroup[]): string {
  const lines = ["# Resume", "", "_Built from your Bullwark facts. Each line names the client and session it came from._", ""];
  for (const g of groups) {
    lines.push(`## ${g.title}`, "");
    for (const f of g.facts) {
      lines.push(`- ${f.statement} (${f.source.client} · ${f.source.session})`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** "work-history" → "Work history"; "skills/typescript" → "Skills / typescript". */
export function titleCase(key: string): string {
  const s = key.replace(/[-_]+/g, " ").replace(/\s*\/\s*/g, " / ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
