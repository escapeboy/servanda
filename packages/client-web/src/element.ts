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

/**
 * What a line-structured medium — a terminal frame, the text part of a mail — has to do to a
 * string before printing it, and the exact counterpart of `escapeHtml` above.
 *
 * The words of a promise are content and are shown verbatim (M-21), but "verbatim" is about
 * the words: a cursor-movement sequence is not a word, and in a medium whose only structure
 * is where the line breaks are, a newline inside a headline is not a character either — it is
 * a second card the register never recorded. `ESC[8m` after a counterparty's name conceals
 * everything printed after it on that line, which on a card is the verification level: the
 * name survives and its evidence does not, which is precisely what M-12 forbids.
 *
 * Control characters become spaces so the line keeps its length rather than closing up around
 * what was removed; bidi overrides go entirely, because there is no width for them to keep.
 * Same two classes `@servanda/gestures` scrubs from a quote, and for the same reason — except
 * that here the text arrives over §7, where `intent_or_expect` and `counterparty` are plain
 * strings that no schema can make safe to print.
 */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]', 'gu');
const BIDI_CHARS = new RegExp('[\\u202A-\\u202E\\u2066-\\u2069]', 'gu');

export function escapeLine(line: string): string {
  return line.replace(CONTROL_CHARS, ' ').replace(BIDI_CHARS, '');
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
