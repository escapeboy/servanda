/**
 * A minimal element tree.
 *
 * Two things need the same tree: the browser, which mounts it as real DOM, and the tests,
 * which walk it to prove things about semantics and keyboard reach. A tree makes both
 * possible without a rendering library and without a headless browser — and, more to the
 * point, it makes "is every action operable without a pointer" a question that can be
 * *answered*, statically, rather than demonstrated once and hoped for afterwards.
 *
 * `renderToHtml` exists for the email projection and for tests. The browser path never
 * round-trips through a server: nothing here is server-rendered, which is what M-10 asks of
 * a client that must work with no network at all.
 */

export interface El {
  readonly tag: string;
  readonly attrs?: Readonly<Record<string, string | number | boolean>>;
  /** Text content. Escaped on render; never interpreted as markup. */
  readonly text?: string;
  readonly children?: readonly El[];
}

export function el(
  tag: string,
  attrs: Readonly<Record<string, string | number | boolean>> = {},
  children: readonly El[] = [],
): El {
  return { tag, attrs, children };
}

export function textEl(
  tag: string,
  text: string,
  attrs: Readonly<Record<string, string | number | boolean>> = {},
): El {
  return { tag, attrs, text };
}

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);

export function escapeHtml(s: string): string {
  return s
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

export function renderToHtml(node: El): string {
  const attrs = Object.entries(node.attrs ?? {})
    .filter(([, v]) => v !== false)
    .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${escapeHtml(String(v))}"`))
    .join('');
  if (VOID_TAGS.has(node.tag)) return `<${node.tag}${attrs}>`;
  const inner =
    node.text !== undefined
      ? escapeHtml(node.text)
      : (node.children ?? []).map(renderToHtml).join('');
  return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
}

/** Depth-first, document order — the order a screen reader and the Tab key both follow. */
export function walk(node: El): El[] {
  const out: El[] = [node];
  for (const child of node.children ?? []) out.push(...walk(child));
  return out;
}

/** All text a person would read, in reading order. What the vocabulary gate scans. */
export function visibleText(node: El): string[] {
  const out: string[] = [];
  for (const n of walk(node)) {
    if (n.text !== undefined && n.text.length > 0) out.push(n.text);
    // An accessible name is read aloud, so it is user-facing text too.
    const label = n.attrs?.['aria-label'];
    if (typeof label === 'string' && label.length > 0) out.push(label);
  }
  return out;
}
