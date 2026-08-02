import type { RenderedFact, Surface } from './fact.js';

/**
 * The two negative universals, and why they are universals rather than per-case assertions.
 *
 * A per-case assertion says "this page does not do the bad thing". A universal says "no string
 * reaches the screen unless it is in one of two named sets", which turns M-21 from an argument
 * into a set difference — and a set difference cannot be satisfied by a page that merely happens
 * to look right on the cases somebody thought to write.
 */

export interface Verdict {
  readonly rule: 'M-12' | 'M-21';
  readonly surface: string;
  readonly detail: string;
  readonly fact?: RenderedFact;
}

export interface Content {
  /**
   * Strings that originate OUTSIDE the client and are permitted to reach the screen verbatim:
   * a person's own recorded words. M-21 exempts these explicitly — "a person's own recorded words
   * are content, not copy" — and everything else a node sends is copy the client must author.
   *
   * The client under test declares this list. That declaration is the point: today the boundary
   * exists only as prose in doc comments, so nothing can check it.
   */
  readonly allowlist: readonly string[];
  /** Every string the client authored itself. */
  readonly copy: readonly string[];
}

const IGNORABLE = /^[\s\p{P}\p{S}\d]*$/u;

/**
 * M-21: no string reaches a rendered fact unless the client wrote it or it is declared content.
 *
 * The defect this catches was not a client copying a node's `label` — that field is gone. It was
 * `buildBrief` painting the node's `headline` as a card's `aria-labelledby` target, i.e. the first
 * thing a screen reader says. `headline`'s guarantee ("the commitment's intent as they wrote it")
 * is a claim about a string that no schema can check, and `z.string()` takes copy as readily as
 * content.
 */
export function judgeCopy(surface: Surface, content: Content): Verdict[] {
  const copy = new Set(content.copy);
  const allowed = new Set(content.allowlist);
  const out: Verdict[] = [];
  for (const fact of surface.facts) {
    const text = fact.text.trim();
    if (text.length === 0 || IGNORABLE.test(text)) continue;
    if (copy.has(text) || allowed.has(text)) continue;
    // A composed line legitimately concatenates copy and content; it passes only if every part of
    // it does. Anything left over is a string nobody claimed.
    const unclaimed = [...copy, ...allowed].reduce((rest, known) => rest.split(known).join(''), text).trim();
    if (unclaimed.length === 0 || IGNORABLE.test(unclaimed)) continue;
    out.push({
      rule: 'M-21',
      surface: surface.id,
      detail: `a string reached the screen that the client neither authored nor declared as content: ${JSON.stringify(unclaimed.slice(0, 80))}`,
      fact,
    });
  }
  return out;
}

export interface NameUnderTest {
  /** The rendered form of the counterparty name. */
  readonly value: string;
  /** §7 v0.2: `attested` is bound by M-12; `self-labelled` is the viewer's own note. */
  readonly origin: 'attested' | 'self-labelled';
  /** The evidence level, as the node reported it. */
  readonly level: string;
  /** Strings that would satisfy "the level is shown here" — client copy, so the client names them. */
  readonly levelMarkers: readonly string[];
  /** Levels that may carry a name at all, read from the node-surface vectors, never restated. */
  readonly nameBearingLevels: readonly string[];
}

/**
 * M-12: an attested name never appears without its evidence, in the same scope.
 *
 * Scope, not document. Both of the surface defects turned on that distinction: an ANSI `\x1b[8m`
 * inside a name conceals everything the terminal prints AFTER it — including the level, which was
 * still present in the frame — and a bidi override reorders the level beside it while leaving the
 * markup intact.
 */
export function judgeName(surface: Surface, name: NameUnderTest): Verdict[] {
  const out: Verdict[] = [];
  if (name.origin === 'self-labelled') {
    // Deliberately unbound. A label the viewer typed makes no claim about anyone, and suppressing
    // it erases the only name an off-network counterparty will ever have — which breaks the solo
    // path the base rule protects. This branch exists so that a client cannot pass by hiding
    // everything.
    const shown = surface.facts.some((f) => f.text.includes(name.value));
    if (!shown) {
      out.push({
        rule: 'M-12',
        surface: surface.id,
        detail: `a self-labelled name was suppressed; M-12 binds attested names only, and this one is the viewer's own note`,
      });
    }
    return out;
  }

  // A name is carried by a fact that contains it, OR by a SCOPE whose facts spell it out between
  // them. Checking facts alone let `Maria Ivanova` be split across two `<span>`s and vanish from
  // the judge entirely — `carrying` came back empty, the early return below fired, and the client
  // passed at every level including one that carries no name at all. A reader sees the name; the
  // harness saw two fragments.
  //
  // Concatenated in reading order, which is the order a person takes them in. This does not model
  // what CSS might do to that order — declared style, not painted pixels, is the limit §8 states
  // and it holds here too.
  const spelledOut = (facts: readonly RenderedFact[]) =>
    facts.some((f) => f.text.includes(name.value)) ||
    facts
      .slice()
      .sort((x, y) => x.ordinal - y.ordinal)
      .map((f) => f.text)
      .join('')
      .includes(name.value);

  const scopesCarrying = new Set(
    [...new Set(surface.facts.map((f) => f.scope))].filter((sc) =>
      spelledOut(surface.facts.filter((f) => f.scope === sc)),
    ),
  );
  const carrying = surface.facts.filter(
    (f) => f.text.includes(name.value) || scopesCarrying.has(f.scope),
  );
  if (carrying.length === 0) return out; // not rendered at all is always safe

  if (!name.nameBearingLevels.includes(name.level)) {
    out.push({
      rule: 'M-12',
      surface: surface.id,
      detail: `an attested name was rendered at level ${name.level}, which carries no name`,
      fact: carrying[0],
    });
    return out;
  }

  // Scopes are paths, so two of them are in one another's reach when one is a PREFIX of the other.
  // Exact equality punished the shipped fix: `client-web` wraps a name in `bdi` to contain a bidi
  // override, that opens a nested scope, and the evidence one level out stopped counting — so
  // doing the right thing failed and doing nothing passed. A `bdi` inside a card is still inside
  // the card, and a reader takes in the group the name sits in.
  //
  // Both directions, because evidence may sit in a container of its own beside the name.
  const related = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

  for (const fact of carrying) {
    const inScope = surface.facts.filter((f) => related(f.scope, fact.scope));
    const evidenceShown = inScope.some((f) =>
      name.levelMarkers.some((m) => f.text.includes(m) || f.classes.includes(m) || Object.values(f.attrs).includes(m)),
    );
    if (!evidenceShown) {
      out.push({
        rule: 'M-12',
        surface: surface.id,
        detail: `an attested name appears in scope ${fact.scope} with none of its evidence markers in the same scope`,
        fact,
      });
    }
  }
  return out;
}

/**
 * The style half, which no assertion over a document can reach.
 *
 * A client that shows the level ONLY as a visual weight is showing it through the stylesheet, and
 * a correct rank table beside a stylesheet that contradicts it renders a worse-evidenced name more
 * emphatically than a better-evidenced one. That is what happened: `ext` was ranked above an
 * attestation and given a heavier rim, and the leak check could not see it because it iterated the
 * levels ranked ABOVE the rendered one — the empty set, at the top rank.
 *
 * `rank` comes from `vectors/node-surface/verification-levels.json`. Restating it here would
 * reproduce the original defect in the harness.
 */
export function judgeStyleOrdering(
  surface: Surface,
  rank: Readonly<Record<string, number>>,
): Verdict[] {
  const depth = surface.styleDepth;
  if (!depth) return [];
  const out: Verdict[] = [];
  const levels = Object.keys(depth).filter((l) => l in rank);
  for (const a of levels) {
    for (const b of levels) {
      if (rank[a]! >= rank[b]!) continue;
      if (depth[a]! > depth[b]!) {
        out.push({
          rule: 'M-12',
          surface: surface.id,
          detail: `level ${a} is drawn more emphatically (${depth[a]}) than ${b} (${depth[b]}), while ranking below it`,
        });
      }
    }
  }
  return out;
}
