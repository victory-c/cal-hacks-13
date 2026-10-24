// Tiny DOM helpers, no framework. h() builds an element; syncList() reconciles a keyed list in
// place, so a row whose content did not change keeps its node and the "new row" highlight plays
// once instead of on every event.

export type Child = Node | string | number | null | undefined | false | Child[];
export type Attrs = Record<string, string | number | boolean | null | undefined | ((ev: Event) => void)>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (typeof v === "function") el.addEventListener(k.replace(/^on/, "").toLowerCase(), v);
      else if (k === "class") el.className = String(v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
}

/** Fails loudly when the HTML and the script disagree, instead of a silent blank panel. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`the page is missing #${id}; index.html and main.ts are out of sync`);
  return el as T;
}

export interface KeyedItem {
  key: string;
  /** Changes when the row's content changes; an equal version keeps the existing node. */
  version: string;
  build: () => HTMLElement;
  /** Adds .is-new on first insertion (the highlight animation) for rows that just happened. */
  fresh?: boolean;
}

/** Makes `container`'s children match `items` in order, touching only what changed. */
export function syncList(container: HTMLElement, items: readonly KeyedItem[], empty?: () => HTMLElement): void {
  const wanted = new Set(items.map((i) => i.key));
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(container.children) as HTMLElement[]) {
    const key = child.dataset.key;
    if (key && wanted.has(key)) existing.set(key, child);
    else child.remove(); // rows that are gone, and the empty-state placeholder
  }
  if (items.length === 0) {
    if (empty) container.replaceChildren(empty());
    return;
  }
  items.forEach((item, i) => {
    const prev = existing.get(item.key);
    let node: HTMLElement;
    if (prev && prev.dataset.version === item.version) {
      node = prev;
    } else {
      node = item.build();
      node.dataset.key = item.key;
      node.dataset.version = item.version;
      if (!prev && item.fresh) node.classList.add("is-new");
      if (prev) prev.replaceWith(node);
    }
    const current = container.children[i] ?? null;
    if (current !== node) container.insertBefore(node, current);
  });
}
