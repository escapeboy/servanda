import { describe, expect, it } from 'vitest';
import type { OpenLoopItem } from '@servanda/types';
import {
  COPY,
  FixtureNodeClient,
  buildBrief,
  buildLedger,
  cardFor,
  consequenceFor,
  loadApp,
  makeFixture,
  partyFor,
  sealFor,
} from '../src/index.js';
import { NOW, app } from './fixture.js';

function item(overrides: Partial<OpenLoopItem> = {}): OpenLoopItem {
  return {
    kind: 'commitment',
    id: 'i1',
    intent_or_expect: 'Send the revised quote',
    counterparty: 'Dana Reyes',
    verification_level: '2',
    age_days: 12,
    due: null,
    state: 'open',
    actions: ['done', 'supersede'],
    ...overrides,
  };
}

describe('every card answers what · with whom · what happens if I do nothing', () => {
  it('fills all three for every card on every surface', async () => {
    for (const surface of ['brief', 'owe', 'waiting', 'closed', 'inbox'] as const) {
      const view = await app(surface);
      const cards =
        surface === 'brief'
          ? view.brief.cards
          : surface === 'inbox'
            ? view.inbox.cards
            : (view.ledger.sections.find((s) => s.id === surface)?.cards ?? []);
      expect(cards.length).toBeGreaterThan(0);
      for (const card of cards) {
        expect(card.what.length).toBeGreaterThan(0);
        expect(card.ifIDoNothing.length).toBeGreaterThan(0);
        // With whom is either a party carrying its evidence, or explicitly just you.
        expect(card.withWhom === null || card.withWhom.trust.label.length > 0).toBe(true);
      }
    }
  });

  it('leads every card with its primary action', async () => {
    const view = await app('owe');
    const cards = view.ledger.sections.find((s) => s.id === 'owe')?.cards ?? [];
    for (const card of cards) {
      expect(card.actions[0]?.primary).toBe(true);
      expect(card.actions.filter((a) => a.primary)).toHaveLength(1);
    }
  });
});

describe('the register speaks in owe / waiting / closed', () => {
  it('splits the sections by what the item is, not by a control the person set', async () => {
    const view = await app('owe');
    expect(view.ledger.sections.map((s) => s.id)).toEqual(['owe', 'waiting', 'closed']);
    expect(view.ledger.sections.map((s) => s.heading)).toEqual([
      COPY.sections.owe,
      COPY.sections.waiting,
      COPY.sections.closed,
    ]);
  });

  it('keeps the order the node gave: attention-market ordering, never a sort control', async () => {
    const fixture = makeFixture(12, NOW);
    const client = new FixtureNodeClient(fixture);
    const view = await loadApp(client, { surface: 'owe', now: NOW });
    const owed = view.ledger.sections.find((s) => s.id === 'owe')?.cards.map((c) => c.id) ?? [];
    const expected = fixture.items
      .filter((i) => i.kind === 'commitment' && i.state !== 'closed')
      .map((i) => i.id);
    expect(owed).toEqual(expected);
  });
});

describe('what happens if I do nothing is a fact about a date, not a verdict', () => {
  it('counts days forward and back without judgment', () => {
    expect(consequenceFor(item({ due: '2026-03-01T09:00:00Z' }), NOW, false).text).toBe('Due today.');
    expect(consequenceFor(item({ due: '2026-03-02T09:00:00Z' }), NOW, false).text).toBe('Due tomorrow.');
    expect(consequenceFor(item({ due: '2026-03-05T09:00:00Z' }), NOW, false).text).toBe('Due in 4 days.');
    expect(consequenceFor(item({ due: '2026-02-25T09:00:00Z' }), NOW, false).text).toBe(
      'The date passed 4 days ago.',
    );
    expect(consequenceFor(item({ due: null, age_days: 12 }), NOW, false).text).toBe(
      'No date. Open 12 days.',
    );
  });

  it('flips the subject when you are the one waiting', () => {
    expect(consequenceFor(item({ due: '2026-03-05T09:00:00Z' }), NOW, true).text).toBe(
      'They have 4 days left.',
    );
    expect(consequenceFor(item({ due: null, age_days: 3 }), NOW, true).text).toBe(
      'No date. Waiting 3 days.',
    );
  });

  it('marks a passed date as its own tone and a settled one as another', () => {
    expect(consequenceFor(item({ due: '2026-02-25T09:00:00Z' }), NOW, false).tone).toBe('passed');
    expect(consequenceFor(item({ state: 'closed' }), NOW, false).tone).toBe('settled');
    expect(consequenceFor(item({ due: '2026-03-05T09:00:00Z' }), NOW, false).tone).toBe('plain');
  });
});

describe('the seal carries the state', () => {
  it('maps each state to exactly one mark', () => {
    expect(sealFor('proposed').shape).toBe('half');
    expect(sealFor('open').shape).toBe('joined');
    expect(sealFor('confirmed').shape).toBe('joined');
    expect(sealFor('closed').shape).toBe('marked');
    expect(sealFor('disputed').shape).toBe('cracked');
    expect(sealFor('superseded').shape).toBe('arrow');
    expect(sealFor('vault-local').shape).toBe('unsealed');
  });

  it('says the mark in words for anyone who cannot see it', () => {
    for (const state of ['proposed', 'open', 'closed', 'disputed', 'superseded', 'vault-local']) {
      expect(sealFor(state).label.length).toBeGreaterThan(0);
    }
  });
});

describe('a key is not a name', () => {
  it('shortens a raw key and marks it as one', () => {
    const party = partyFor('a'.repeat(64), '1');
    expect(party?.isKey).toBe(true);
    expect(party?.display).toBe('aaaaaa…aaaa');
  });

  it('leaves a written name alone', () => {
    expect(partyFor('Dana Reyes', '3')?.display).toBe('Dana Reyes');
    expect(partyFor('Dana Reyes', '3')?.isKey).toBe(false);
  });

  it('has no party at all when the promise is to yourself', () => {
    expect(partyFor(null, '0')).toBeNull();
  });
});

describe('the brief is a projection of the register, not a second one', () => {
  it("honours the node's choice of leading action, and the node ships no wording to adopt", async () => {
    const fixture = makeFixture(6, NOW);
    const brief = buildBrief(fixture.brief, { items: [...fixture.items] }, NOW);

    // M-21, stated structurally rather than by comparison. This used to assert that the client
    // did not reuse the node's `label`; there is no longer a label to reuse, which is a stronger
    // guarantee than declining to copy one.
    for (const slot of fixture.brief.slots) {
      if (slot.primary_action === null) continue;
      expect(Object.keys(slot.primary_action).sort()).toEqual(['act', 'args', 'tool']);
    }

    // Every word a person reads came from this client's own table.
    for (const card of brief.cards) {
      for (const action of card.actions) {
        expect(Object.values(COPY.actions)).toContain(action.label);
      }
    }
  });

  it('passes the person’s own words through untouched', () => {
    const words = 'Return the signed lease addendum';
    const card = cardFor(item({ intent_or_expect: words }), NOW, false);
    expect(card.what).toBe(words);
  });

  it('drops a slot with nothing behind it rather than showing a headline alone', () => {
    const fixture = makeFixture(4, NOW);
    const brief = buildBrief(fixture.brief, { items: [] }, NOW);
    expect(brief.cards).toEqual([]);
  });

  it('says how many slots it could not resolve instead of dropping them in silence', () => {
    // Not the rare case it reads as. §7 lets `brief` rank across every persona — the one place
    // cross-org ordering is allowed — while `open_loops` with `persona: null` resolves to the
    // ACTIVE persona alone, because it returns content and a second mixing point is what M-5
    // forbids. So on the ordinary multi-persona path every slot of every other persona lands in
    // that branch. Showing four of nine and calling it the brief is a partial ranking presented
    // as the whole one; the count is what makes the difference visible.
    const fixture = makeFixture(4, NOW);
    expect(buildBrief(fixture.brief, { items: [] }, NOW).unresolved).toBe(fixture.brief.slots.length);
    expect(buildBrief(fixture.brief, { items: [...fixture.items] }, NOW).unresolved).toBe(0);
  });

  it('counts what is below the line without turning it into a nudge', () => {
    const fixture = makeFixture(24, NOW);
    const brief = buildBrief(fixture.brief, { items: [...fixture.items] }, NOW);
    expect(brief.belowTheLine).toBe('18 more, further down.');
  });
});

describe('the confirmation queue records nothing until a person says so', () => {
  it('offers exactly confirm and dismiss, both through §7 confirm', async () => {
    const view = await app('inbox');
    expect(view.inbox.cards.length).toBeGreaterThan(0);
    for (const card of view.inbox.cards) {
      expect(card.actions.map((a) => a.label)).toEqual([COPY.actions.confirm, COPY.actions.dismiss]);
      for (const action of card.actions) {
        expect(action.dispatch).toMatchObject({ kind: 'tool', tool: 'confirm' });
      }
      expect(card.ifIDoNothing).toBe(COPY.inbox.consequence);
    }
  });

  it('reaches the node through confirm and nothing else', async () => {
    const fixture = makeFixture(6, NOW);
    const client = new FixtureNodeClient(fixture);
    const view = await loadApp(client, {
      surface: 'inbox',
      now: NOW,
      pending: { items: fixture.pending },
    });
    const first = view.inbox.cards[0]?.actions[0];
    expect(first?.dispatch.kind).toBe('tool');
    if (first?.dispatch.kind === 'tool') {
      const args = first.dispatch.args as { id: string; decision: 'confirm' };
      await client.confirm({ id: args.id, decision: args.decision });
    }
    expect(client.confirmed).toEqual([{ id: 'pending-0', decision: 'confirm' }]);
  });
});

describe('the same node state renders the same way twice', () => {
  it('reads no clock: only the injected instant moves the output', async () => {
    const a = await app('brief');
    const b = await app('brief');
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe('there is no manual ordering, foldering, tagging or projects', () => {
  it('exposes no such affordance on any surface', async () => {
    const view = await app('owe');
    const serialised = JSON.stringify(view).toLowerCase();
    for (const affordance of ['sortby', 'folder', 'tag', 'project', 'priority', 'streak', 'score']) {
      expect(serialised).not.toContain(affordance);
    }
  });
});
