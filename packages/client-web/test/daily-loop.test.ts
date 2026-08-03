import { describe, expect, it } from 'vitest';
import type { OpenLoopItem } from '@servanda/types';
import { COPY } from '../src/copy.js';
import { briefEl } from '../src/render.js';
import { visibleText } from '../src/element.js';
import { buildBrief, consequenceFor } from '../src/view.js';

/**
 * The morning loop, read at an hour that is not midnight.
 *
 * Every date case the existing tests cover sits at an exact 24-hour multiple from `now`
 * (09:00 to 09:00), which is the one arrangement in which elapsed milliseconds and calendar
 * days agree. A person does not read their register at the same minute every morning.
 */

function item(over: Partial<OpenLoopItem> = {}): OpenLoopItem {
  return {
    kind: 'commitment',
    id: 'i',
    intent_or_expect: 'Send the revised quote',
    counterparty: null,
    verification_level: '0',
    age_days: 2,
    due: null,
    state: 'open',
    actions: [],
    ...over,
  } as OpenLoopItem;
}

describe('what happens if I do nothing, read at any hour', () => {
  it('does not age a date that passed this morning into yesterday', () => {
    const now = '2026-08-03T23:00:00Z';
    expect(consequenceFor(item({ due: '2026-08-03T09:00:00Z' }), now, false).text).toBe(
      COPY.consequence.passedToday,
    );
    expect(consequenceFor(item({ due: '2026-08-03T09:00:00Z' }), now, true).text).toBe(
      COPY.consequence.theirsPassedToday,
    );
  });

  it('says yesterday for yesterday, whatever hour of yesterday it was', () => {
    const now = '2026-08-03T01:00:00Z';
    for (const due of ['2026-08-02T00:00:00Z', '2026-08-02T12:00:00Z', '2026-08-02T23:59:00Z']) {
      expect(consequenceFor(item({ due }), now, false).text, due).toBe(
        COPY.consequence.passedDays(1),
      );
    }
  });

  it('does not pull tomorrow forward into today', () => {
    // Read in the evening, due first thing in the morning: 9 hours away, and tomorrow.
    expect(
      consequenceFor(item({ due: '2026-08-04T08:00:00Z' }), '2026-08-03T23:00:00Z', false).text,
    ).toBe(COPY.consequence.dueTomorrow);
  });

  it('counts the days to a date the way a calendar does', () => {
    expect(
      consequenceFor(item({ due: '2026-08-06T08:00:00Z' }), '2026-08-03T23:00:00Z', false).text,
    ).toBe(COPY.consequence.dueInDays(3));
  });

  it('keeps the tone with the fact: a date still ahead today is not amber', () => {
    const now = '2026-08-03T08:00:00Z';
    expect(consequenceFor(item({ due: '2026-08-03T17:00:00Z' }), now, false).tone).toBe('plain');
    expect(consequenceFor(item({ due: '2026-08-03T07:00:00Z' }), now, false).tone).toBe('passed');
  });

  it('says nothing it cannot work out from an unreadable date', () => {
    const c = consequenceFor(item({ due: 'the end of the quarter' }), '2026-08-03T08:00:00Z', false);
    expect(c.text).not.toContain('NaN');
  });
});

/**
 * §7 lets `brief` rank across every persona and lets `open_loops` read only the active one.
 * A person who followed USAGE §1 and made a second persona therefore has a brief whose slots
 * this surface cannot resolve — and `buildBrief` counts them. Nothing rendered the count.
 */
describe('a brief that could not show everything it was given says so', () => {
  const NOW = '2026-08-03T09:00:00Z';
  const brief = {
    generated_at: NOW,
    slots: [
      { headline: 'Something on the other persona', item_id: 'elsewhere-1', primary_action: null },
      { headline: 'Something else there too', item_id: 'elsewhere-2', primary_action: null },
    ],
    below_the_line_count: 0,
  };

  it('has a line for the slots it could not resolve', () => {
    const view = buildBrief(brief, { items: [] }, NOW);
    expect(view.unresolved).toBe(2);
    expect(view.unresolvedLine).not.toBeNull();
  });

  it('shows that line to a person rather than only to the view model', () => {
    const view = buildBrief(brief, { items: [] }, NOW);
    expect(visibleText(briefEl(view))).toContain(view.unresolvedLine);
  });

  it('says nothing when there is nothing to say', () => {
    const view = buildBrief({ ...brief, slots: [] }, { items: [] }, NOW);
    expect(view.unresolvedLine).toBeNull();
    expect(visibleText(briefEl(view)).join('\n')).not.toContain('elsewhere');
  });
});
