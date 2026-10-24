// Options page: Canon URL + client token into chrome.storage.local, and a status line with the last
// POST result the service worker recorded. Plain DOM, no framework; runs only inside Chrome.

import { ROUTES } from "@canon/shared";
import type { HealthResponse } from "@canon/shared";
import { normalizeSettings, STORAGE } from "./shared/settings.ts";
import type { PostResult } from "./shared/settings.ts";

const field = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;
const status = document.getElementById("status") as HTMLDivElement;

function show(kind: "ok" | "err" | "", text: string): void {
  status.className = kind;
  status.textContent = text;
}

/** Whichever of the last success / last error is newer is what the user needs to see. */
function showLastResult(raw: Record<string, unknown>): void {
  const ok = raw[STORAGE.lastSuccess] as PostResult | undefined;
  const err = raw[STORAGE.lastError] as PostResult | undefined;
  if (!ok && !err) return show("", "No posts yet. Open chatgpt.com and send a message.");
  const newest = !err || (ok && ok.at > err.at) ? ok! : err;
  const when = new Date(newest.at).toLocaleTimeString();
  show(newest === ok ? "ok" : "err", `${newest === ok ? "✓" : "✗"} ${when} · ${newest.message}`);
}

async function load(): Promise<void> {
  const raw = await chrome.storage.local.get(null);
  const settings = normalizeSettings(raw);
  field("canonUrl").value = settings.canonUrl;
  field("token").value = settings.token;
  field("principal").value = settings.principal;
  showLastResult(raw);
}

async function save(): Promise<void> {
  const settings = normalizeSettings({ canonUrl: field("canonUrl").value, token: field("token").value, principal: field("principal").value });
  await chrome.storage.local.set({ [STORAGE.canonUrl]: settings.canonUrl, [STORAGE.token]: settings.token, [STORAGE.principal]: settings.principal });
  field("canonUrl").value = settings.canonUrl;
  field("principal").value = settings.principal;
  if (!settings.token) return show("err", "Saved, but the token is empty: posts will fail until you paste it.");
  show("ok", settings.principal ? `Saved. Sessions go out as ${settings.principal}.` : "Saved. No principal set: sessions go out as unknown, and triage treats them cautiously.");
}

/** GET /health needs no token, so this checks the URL and that the server is up, nothing more. */
async function testConnection(): Promise<void> {
  const url = `${normalizeSettings({ canonUrl: field("canonUrl").value }).canonUrl.replace(/\/+$/, "")}${ROUTES.health}`;
  show("", `Checking ${url} …`);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const h = (await res.json()) as HealthResponse;
    show("ok", `✓ Server up · ${h.facts} facts · ${h.sessions} sessions · judge ${h.judge} · retriever ${h.retriever}`);
  } catch (err) {
    show("err", `✗ ${url}: ${err instanceof Error ? err.message : String(err)}. Is the server running (npm run dev)?`);
  }
}

document.getElementById("save")!.addEventListener("click", () => void save());
document.getElementById("test")!.addEventListener("click", () => void testConnection());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (STORAGE.lastSuccess in changes || STORAGE.lastError in changes)) void load();
});
void load();
