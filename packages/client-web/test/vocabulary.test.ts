import { describe, expect, it } from 'vitest';
import {
  COPY,
  FORBIDDEN_TERMS,
  allCopyStrings,
  appEl,
  buildBrief,
  buildLedger,
  makeFixture,
  scanAll,
  scanExclamations,
  scanVocabulary,
  visibleText,
} from '../src/index.js';
import { NOW, everySurface } from './fixture.js';

/**
 * The vocabulary law, checked against what a person actually reads. Internal type names may
 * say whatever the protocol says; the interface may not.
 */
describe('no surface speaks the vocabulary of its own machinery', () => {
  it('keeps the string table clean', () => {
    expect(scanAll(allCopyStrings())).toEqual([]);
  });

  it('keeps every rendered surface clean', async () => {
    for (const view of await everySurface()) {
      expect(scanAll(visibleText(appEl(view)))).toEqual([]);
    }
  });

  it('has no exclamation mark anywhere a person can see', async () => {
    for (const view of await everySurface()) {
      expect(scanExclamations(visibleText(appEl(view)))).toEqual([]);
    }
    expect(scanExclamations(allCopyStrings())).toEqual([]);
  });

  it('would catch each forbidden term if one slipped in', () => {
    for (const term of FORBIDDEN_TERMS) {
      expect(scanVocabulary([`Open the ${term} to continue`])).toHaveLength(1);
    }
    expect(scanVocabulary(['Acknowledge the change'])).toEqual([]);
    expect(scanVocabulary(['A knowledge base'])).toEqual([]);
  });
});

/**
 * The scanner must be checking the interface, not sanitising the person's own words — those
 * are content and are passed through untouched. This test proves the distinction is real by
 * showing the terms survive in content while the chrome around them stays clean.
 */
describe('the words come from the interface, never from the connection', () => {
  it('renders a person’s own text verbatim even when it uses machinery words', () => {
    const fixture = makeFixture(4, NOW);
    const hostile = {
      items: fixture.items.map((item) => ({
        ...item,
        intent_or_expect: 'Migrate the vault and retire the old node',
      })),
    };
    const ledger = buildLedger(hostile, NOW);
    const owed = ledger.sections.find((s) => s.id === 'owe')?.cards ?? [];
    expect(owed.length).toBeGreaterThan(0);
    expect(owed[0]?.what).toBe('Migrate the vault and retire the old node');
  });

  it('ignores a label the node supplies, however it is worded', () => {
    const fixture = makeFixture(4, NOW);
    const shouty = {
      ...fixture.brief,
      slots: fixture.brief.slots.map((slot) => ({
        ...slot,
        primary_action: { ...slot.primary_action, label: 'CLOSE THE EDGE IN YOUR VAULT NOW!!!' },
      })),
    };
    const brief = buildBrief(shouty, { items: [...fixture.items] }, NOW);
    const labels = brief.cards.flatMap((c) => c.actions.map((a) => a.label));
    expect(labels.length).toBeGreaterThan(0);
    expect(scanAll(labels)).toEqual([]);
    for (const label of labels) expect(Object.values(COPY.actions)).toContain(label);
  });
});
