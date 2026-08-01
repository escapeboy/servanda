import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  HOSTILE_TWINS,
  NAME_CASES,
  factsFromLines,
  factsFromTree,
  judgeCopy,
  judgeName,
  judgeStyleOrdering,
  type RenderedFact,
  type Surface,
} from '../src/index.js';

/**
 * The harness judging itself.
 *
 * Every check here is written the way the repo learned to write them: a deliberately WRONG surface
 * that must be caught, beside a right one that must not be. A judge that only ever sees correct
 * input is the same decoration as a vector nobody feeds to an implementation.
 */

const LEVELS = JSON.parse(
  readFileSync('vendor/vectors/node-surface/verification-levels.json', 'utf8'),
) as { level_rank: Record<string, number>; cases: { expected: { level: string; name_bearing: boolean } }[] };

/** Read from the oracle, never restated — a hand-written copy is where the `ext` defect lived. */
const NAME_BEARING = [
  ...new Set(LEVELS.cases.filter((c) => c.expected.name_bearing).map((c) => c.expected.level)),
];

const fact = (over: Partial<RenderedFact> = {}): RenderedFact => ({
  tag: 'p',
  classes: [],
  attrs: {},
  text: '',
  ordinal: 0,
  scope: 'root',
  ...over,
});

const surface = (facts: RenderedFact[], id = 'web'): Surface => ({ id, facts });

describe('the fact set is the unit, not the document', () => {
  it('gives an accessible name its own fact', () => {
    // M-21 was violated here: the node's `headline` became a card's `aria-labelledby` target, the
    // first thing a screen reader says. Folded into its element's text, it would be invisible.
    const facts = factsFromTree(
      { tag: 'p', attrs: { 'aria-label': 'read aloud first' }, text: 'shown', children: [] },
      {
        tag: (n) => (n as { tag: string }).tag,
        attrs: (n) => (n as { attrs: Record<string, string> }).attrs,
        text: (n) => (n as { text?: string }).text,
        children: (n) => (n as { children: unknown[] }).children,
      },
    );
    expect(facts.map((f) => f.text)).toEqual(['shown', 'read aloud first']);
  });

  it('opens a new scope at a bidi isolate and nowhere else', () => {
    const read = {
      tag: (n: unknown) => (n as { tag: string }).tag,
      attrs: (n: unknown) => (n as { attrs?: Record<string, string> }).attrs ?? {},
      text: (n: unknown) => (n as { text?: string }).text,
      children: (n: unknown) => (n as { children?: unknown[] }).children ?? [],
    };
    const facts = factsFromTree(
      {
        tag: 'p',
        children: [
          { tag: 'bdi', text: 'a name' },
          { tag: 'span', text: 'its level' },
        ],
      },
      read,
    );
    // The name is isolated; the level beside it is not in that isolate. That is the containment
    // the bidi fix installed, and the harness has to be able to see it.
    expect(facts[0]!.scope).not.toBe(facts[1]!.scope);
  });

  it('makes each line its own scope', () => {
    const facts = factsFromLines(['name and level', 'something else']);
    expect(new Set(facts.map((f) => f.scope)).size).toBe(2);
  });
});

describe('M-21: no string reaches the screen unless somebody claimed it', () => {
  const content = { allowlist: ['ship the invoice by Friday'], copy: ['You owe', 'Due tomorrow'] };

  it('passes a surface built from copy and declared content', () => {
    const s = surface([
      fact({ text: 'You owe' }),
      fact({ text: 'ship the invoice by Friday', ordinal: 1 }),
      fact({ text: 'Due tomorrow', ordinal: 2 }),
    ]);
    expect(judgeCopy(s, content)).toEqual([]);
  });

  it('catches a string the node supplied and the client painted', () => {
    // The exact defect: a headline that is an instruction rather than the person's own words.
    const s = surface([fact({ text: HOSTILE_TWINS.find((t) => t.member === 'headline')!.value })]);
    const verdicts = judgeCopy(s, content);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.rule).toBe('M-21');
  });

  it('allows a line that composes copy around content', () => {
    const s = surface([fact({ text: 'You owe ship the invoice by Friday' })]);
    expect(judgeCopy(s, content)).toEqual([]);
  });
});

describe('M-12: an attested name never appears without its evidence, in the same scope', () => {
  const markers = ['seal', 'relief-attested'];
  const nameOf = (caseName: string) => NAME_CASES.find((c) => c.name === caseName)!;

  const under = (c: (typeof NAME_CASES)[number]) => ({
    value: c.value,
    origin: c.origin,
    level: c.level,
    levelMarkers: markers,
    nameBearingLevels: NAME_BEARING,
  });

  it('passes a name shown beside its evidence', () => {
    const c = nameOf('attested-name-at-a-name-bearing-level');
    const s = surface([
      fact({ text: c.value, scope: 'card' }),
      fact({ text: 'seal', ordinal: 1, scope: 'card' }),
    ]);
    expect(judgeName(s, under(c))).toEqual([]);
  });

  it('catches an attested name whose evidence is elsewhere on the page', () => {
    // Present in the document, absent from the scope — which is what an ANSI conceal and a bidi
    // override each produce, by different means.
    const c = nameOf('attested-name-at-a-name-bearing-level');
    const s = surface([
      fact({ text: c.value, scope: 'card' }),
      fact({ text: 'seal', ordinal: 1, scope: 'footer' }),
    ]);
    expect(judgeName(s, under(c))).toHaveLength(1);
  });

  it('catches an attested name at `ext`, which carries no name however high it ranks', () => {
    const c = nameOf('attested-name-at-ext');
    const s = surface([fact({ text: c.value, scope: 'card' }), fact({ text: 'seal', ordinal: 1, scope: 'card' })]);
    const verdicts = judgeName(s, under(c));
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.detail).toMatch(/carries no name/);
  });

  it('REQUIRES a self-labelled name to be shown', () => {
    // Without this, a client passes M-12 by hiding every name — and the person loses the only name
    // an off-network counterparty has. The suppression is the violation here.
    const c = nameOf('self-labelled-name-at-level-0');
    expect(judgeName(surface([fact({ text: 'nothing here' })]), under(c))).toHaveLength(1);
    expect(judgeName(surface([fact({ text: c.value })]), under(c))).toEqual([]);
  });
});

describe('M-12: the stylesheet can contradict a correct rank table', () => {
  it('catches a level drawn more emphatically than one that outranks it', () => {
    // The real defect, reproduced: `ext` given a 3px rim while an attestation had 2px, with the
    // rank table itself correct. No assertion over the DOM could see this.
    const s: Surface = {
      id: 'web',
      facts: [],
      styleDepth: { '0': 0, '1': 1, ext: 3, '2': 2, '3': 4 },
    };
    const verdicts = judgeStyleOrdering(s, LEVELS.level_rank);
    expect(verdicts.some((v) => v.detail.includes('level ext is drawn more emphatically'))).toBe(true);
  });

  it('passes a stylesheet that agrees with the ladder', () => {
    const s: Surface = { id: 'web', facts: [], styleDepth: { '0': 0, '1': 1, ext: 2, '2': 3, '3': 4 } };
    expect(judgeStyleOrdering(s, LEVELS.level_rank)).toEqual([]);
  });
});

describe('the case set is adversarial by construction', () => {
  it('ships a hostile twin for every member a client renders verbatim', () => {
    // A harness of well-formed cases re-proves what the node vectors already prove. All four
    // client defects needed an input nobody had thought to write.
    const members = new Set(HOSTILE_TWINS.map((t) => t.member));
    expect(members).toEqual(new Set(['counterparty', 'headline', 'intent_or_expect']));
  });

  it('carries the characters that actually broke a surface, not a description of them', () => {
    const values = HOSTILE_TWINS.map((t) => t.value).join('');
    expect(values).toContain('‮'); // bidi override — reordered the level in the browser
    expect(values).toContain('[8m'); // SGR conceal — hid the level in the terminal
    expect(values).toContain('\n'); // ended the line before the level printed
  });

  it('names the levels that carry a name from the oracle rather than restating them', () => {
    expect(NAME_BEARING.sort()).toEqual(['2', '3']);
    // And the ladder itself is the vector's, so a client and the harness cannot drift apart.
    expect(LEVELS.level_rank['ext']).toBeLessThan(LEVELS.level_rank['2']!);
  });
});
