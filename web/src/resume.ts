// Resume viewer entrypoint: GET /api/facts?folder=career&tier=hot, group by subfolder, one line
// per fact naming its source (client + session id). The session itself sits behind a bearer token
// on the server (GET /api/sessions/:id), which the browser does not have, so the id is text, not
// a link that would land on 401. No LLM here (resume writing is a later task).

import { ROUTES } from "@canon/shared";
import type { Fact, ListFactsResponse } from "@canon/shared";

import { resolveServerUrl, safeStorage } from "./config.ts";
import { byId, h } from "./dom.ts";
import { clientLabel } from "./format.ts";
import { groupCareerFacts, resumeMarkdown } from "./resume-data.ts";

const server = resolveServerUrl(location.search, safeStorage());
byId("server-url").textContent = server;
byId<HTMLAnchorElement>("dashboard-link").href = `./index.html?server=${encodeURIComponent(server)}`;

async function main(): Promise<void> {
  const root = byId("resume");
  const count = byId("resume-count");
  const copy = byId<HTMLButtonElement>("copy-md");
  root.replaceChildren(h("p", { class: "empty" }, "Loading facts…"));

  let facts: Fact[];
  try {
    const res = await fetch(`${server}${ROUTES.facts}?folder=career&tier=hot`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as ListFactsResponse;
    facts = Array.isArray(body.facts) ? body.facts : [];
  } catch (err) {
    root.replaceChildren(h("p", { class: "error" }, `Could not load facts from ${server} (${String(err)}). Is the server running? Try: npm run dev -w server`));
    return;
  }

  const groups = groupCareerFacts(facts);
  const n = groups.reduce((sum, g) => sum + g.facts.length, 0);
  count.textContent = `${n} hot career fact${n === 1 ? "" : "s"}`;
  if (groups.length === 0) {
    root.replaceChildren(h("p", { class: "empty" }, "No hot career facts yet. Capture a session and let the distiller run; facts filed under career/ show up here."));
    return;
  }

  root.replaceChildren(
    ...groups.map((g) =>
      h(
        "section",
        { class: "resume-group" },
        h("h2", null, g.title, h("span", { class: "count num" }, String(g.facts.length))),
        h(
          "ul",
          null,
          ...g.facts.map((f) =>
            h(
              "li",
              null,
              h("span", { class: "statement" }, f.statement),
              h("span", { class: "chip client", title: `updated ${f.updated}` }, clientLabel(f.source.client)),
              h("span", { class: "mono dim", title: `source session ${f.source.session} (GET /api/sessions/:id, token required)` }, f.source.session),
            ),
          ),
        ),
      ),
    ),
  );

  copy.disabled = false;
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(resumeMarkdown(groups));
      copy.textContent = "Copied";
    } catch {
      copy.textContent = "Clipboard blocked";
    }
    setTimeout(() => (copy.textContent = "Copy as markdown"), 1500);
  });
}

void main();
