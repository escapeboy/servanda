/**
 * A rendered fact, and why the harness refuses to work in substrings.
 *
 * §8 records that a vector pins what a NODE emits and cannot inspect what a client PAINTS, so the
 * client halves of M-12 and M-21 are prose obligations. Everything that actually broke those rules
 * in this repo broke in the last inch: a class on an element, an escape byte inside a line, a
 * border-width in a stylesheet. None of it is reachable from the node's output.
 *
 * So the unit here is not a string. `toContain('relief-attested')` passed for months against a page
 * where the relief was invisible, because a substring cannot say WHICH element carries a class, and
 * a document that mentions the right word somewhere is not a document that shows it. A fact names
 * one element: its tag, the classes on it, its attributes, the text it carries, and where it sits in
 * reading order. Assertions are made against sets of those.
 */

export interface RenderedFact {
  /** `line` for a terminal or plaintext surface, which has no elements to name. */
  readonly tag: string;
  readonly classes: readonly string[];
  readonly attrs: Readonly<Record<string, string>>;
  /** Exactly the characters a person reads here. Never a subtree's concatenation. */
  readonly text: string;
  /** Position in reading order — the order a screen reader and the Tab key both follow. */
  readonly ordinal: number;
  /**
   * The scope a name and its evidence must share.
   *
   * On a document surface this is the nearest ancestor that establishes a bidi context; on a line
   * surface it is the line. Two of the three M-12 defects found by adversarial testing turned on
   * exactly this: an ANSI escape and a bidi override each reordered or concealed the level while
   * leaving it present in the document.
   */
  readonly scope: string;
}

/** What a client under test must hand the harness. Three surfaces, one shape. */
export interface Surface {
  /** `web`, `terminal`, `email` — named only so a failure says which one. */
  readonly id: string;
  readonly facts: readonly RenderedFact[];
  /**
   * Declared style, where the surface has any. A rank table can be right while the wax says
   * otherwise: `ext` was struck with a deeper seal than an attestation because the CSS disagreed
   * with the ordering, and no assertion over the DOM could see it.
   */
  readonly styleDepth?: Readonly<Record<string, number>>;
}

/** Facts in reading order from a tree, one per node that carries text or an accessible name. */
export function factsFromTree(
  root: unknown,
  read: {
    tag: (n: unknown) => string;
    attrs: (n: unknown) => Readonly<Record<string, string | number | boolean>>;
    text: (n: unknown) => string | undefined;
    children: (n: unknown) => readonly unknown[];
  },
): RenderedFact[] {
  const out: RenderedFact[] = [];
  let ordinal = 0;

  const visit = (node: unknown, scope: string): void => {
    const attrsRaw = read.attrs(node) ?? {};
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(attrsRaw)) attrs[k] = String(v);
    const tag = read.tag(node);
    const classes = (attrs['class'] ?? '').split(/\s+/u).filter((c) => c.length > 0);

    // A `bdi` (or an explicit `dir`) starts a new bidi scope, which is the whole reason the fix
    // for the reordering defect was containment rather than censorship.
    const opensScope = tag === 'bdi' || attrs['dir'] !== undefined;
    const here = opensScope ? `${scope}/${tag}#${ordinal}` : scope;

    const text = read.text(node);
    const label = attrs['aria-label'];
    if ((text !== undefined && text.length > 0) || (label !== undefined && label.length > 0)) {
      out.push({ tag, classes, attrs, text: text ?? '', ordinal: ordinal++, scope: here });
      // An accessible name is read aloud, so it is user-facing text and gets its own fact rather
      // than riding along inside another one. M-21 was violated on exactly this surface.
      if (label !== undefined && label.length > 0 && label !== text) {
        out.push({ tag: `${tag}[aria-label]`, classes, attrs, text: label, ordinal: ordinal++, scope: here });
      }
    }
    for (const child of read.children(node) ?? []) visit(child, here);
  };

  visit(root, 'root');
  return out;
}

/** Facts from a line surface — a terminal frame or a plaintext email body. */
export function factsFromLines(lines: readonly string[]): RenderedFact[] {
  return lines.map((text, i) => ({
    tag: 'line',
    classes: [],
    attrs: {},
    text,
    ordinal: i,
    // The line IS the scope. A `\n` inside a value ends it early and an SGR sequence conceals the
    // rest of it — both were real, and both are invisible to an assertion over the whole frame.
    scope: `line#${i}`,
  }));
}
