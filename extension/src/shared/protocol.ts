// Messages from a content script to the background service worker. One kind for now: every turn
// on the page right now. Content scripts always re-send the whole list; the server replaces the
// session's messages wholesale (CapturedSession.messages), so there is no diffing to get wrong.

export const SITES = ["chatgpt", "claude", "gemini"] as const;
export type Site = (typeof SITES)[number];

export interface Turn {
  role: "user" | "assistant";
  text: string;
  /** 0-based position in the conversation, in page order. */
  index: number;
}

export interface TurnsMessage {
  kind: "turns";
  site: Site;
  /** The site's own conversation id (ChatGPT: the /c/<id> path), or "new-<tab id>" before it has one. */
  conversationId: string;
  url: string;
  /** Page title, when it is a real conversation title and not just the site name. */
  title?: string;
  turns: Turn[];
  /** True on pagehide: the tab is closing or navigating away. Lets the server run the final distill. */
  ended?: boolean;
}

/** The service worker trusts nothing it receives; this is the only gate. */
export function isTurnsMessage(x: unknown): x is TurnsMessage {
  if (typeof x !== "object" || x === null) return false;
  const m = x as Record<string, unknown>;
  return (
    m.kind === "turns" &&
    typeof m.site === "string" &&
    (SITES as readonly string[]).includes(m.site) &&
    typeof m.conversationId === "string" &&
    m.conversationId.length > 0 &&
    typeof m.url === "string" &&
    Array.isArray(m.turns)
  );
}
