import { describe, expect, it } from 'vitest';
import { factsFromTree } from '../src/fact.js';
import { judgeName } from '../src/judge.js';

/**
 * Two ways a client defeated this harness while misleading a person, both found by attacking it
 * rather than reading it.
 *
 * **A name split across two elements vanished from the judge.** `judgeName` looked for the name
 * inside a single fact's text; `Maria Ivanova` rendered as `<span>Maria </span><span>Ivanova</span>`
 * matched none, `carrying` came back empty, and the early return — *"not rendered at all is always
 * safe"* — fired. The client passed at every level, including one that carries no name at all. A
 * reader sees the name. The harness saw two fragments.
 *
 * **A whole page was one scope.** Scope opened only at `bdi` or an explicit `dir`, so M-12's "in
 * the same scope" was satisfied by a level marker anywhere on the page — a name in the heading,
 * its evidence in the footer. And perversely, wrapping the name in `bdi`, which is the shipped fix
 * for the reordering defect, was what made a client FAIL. A model that punishes the correct
 * behaviour is worse than no model.
 */

const el = (tag: string, text: string, attrs: Record<string, string> = {}, children: unknown[] = []) => ({
  tag,
  text,
  attrs,
  children,
});

const read = {
  tag: (n: unknown) => (n as { tag: string }).tag,
  attrs: (n: unknown) => (n as { attrs: Record<string, string> }).attrs,
  text: (n: unknown) => (n as { text: string }).text || undefined,
  children: (n: unknown) => (n as { children: unknown[] }).children ?? [],
};

const NAME = { value: 'Maria Ivanova', origin: 'attested' as const, level: 'ext' as const, nameBearingLevels: ['2', '3'] };

describe('M-12: a name a reader can see is a name the harness can see', () => {
  it('catches a name split across two elements', () => {
    const tree = el('div', '', {}, [el('span', 'Maria '), el('span', 'Ivanova')]);
    const surface = { id: 'web', facts: factsFromTree(tree, read) };

    const findings = judgeName(surface, NAME);
    expect(findings.length, JSON.stringify(surface.facts)).toBeGreaterThan(0);
    expect(findings[0]!.rule).toBe('M-12');
  });

  it('and still catches it whole, in one element', () => {
    const tree = el('div', '', {}, [el('span', 'Maria Ivanova')]);
    const surface = { id: 'web', facts: factsFromTree(tree, read) };
    expect(judgeName(surface, NAME).length).toBeGreaterThan(0);
  });

  it('and says nothing when the name is genuinely not rendered', () => {
    // The control. A judge that flagged every surface would pass both cases above.
    const tree = el('div', '', {}, [el('span', 'a promise'), el('span', 'seal · verified')]);
    const surface = { id: 'web', facts: factsFromTree(tree, read) };
    expect(judgeName(surface, NAME)).toEqual([]);
  });
});

describe('M-12: scope is what a reader groups by, not only what bidi isolates', () => {
  const nameBearing = { ...NAME, level: '2' as const, levelMarkers: ['level-2'] };

  it('evidence in a different section does not qualify a name in this one', () => {
    const tree = el('main', '', {}, [
      el('section', '', {}, [el('h2', 'Maria Ivanova')]),
      el('footer', '', {}, [el('span', 'seal · verified', { class: 'level-2' })]),
    ]);
    const surface = { id: 'web', facts: factsFromTree(tree, read) };
    expect(judgeName(surface, nameBearing).length).toBeGreaterThan(0);
  });

  it('evidence beside it does', () => {
    const tree = el('main', '', {}, [
      el('section', '', {}, [el('h2', 'Maria Ivanova'), el('span', 'seal · verified', { class: 'level-2' })]),
    ]);
    const surface = { id: 'web', facts: factsFromTree(tree, read) };
    expect(judgeName(surface, nameBearing)).toEqual([]);
  });

  it('and wrapping the name in `bdi` — the shipped fix — does not make it fail', () => {
    // The perverse case. `bdi` is what `client-web` uses to contain a bidi override, and under the
    // old model it opened a scope the evidence was outside of, so doing the right thing was
    // punished. A scope opened by containment must still be able to see the group it sits in.
    const tree = el('main', '', {}, [
      el('section', '', {}, [
        el('h2', '', {}, [el('bdi', 'Maria Ivanova')]),
        el('span', 'seal · verified', { class: 'level-2' }),
      ]),
    ]);
    const surface = { id: 'web', facts: factsFromTree(tree, read) };
    expect(judgeName(surface, nameBearing)).toEqual([]);
  });
});
