import { describe, expect, it } from 'vitest';
import type { OpenLoopItem, OpenLoopsOutput } from '@servanda/types';
import { FixtureNodeClient, makeFixture } from '../src/fixture-node.js';
import { loadApp } from '../src/index.js';
import { buildBrief, buildLedger, waitingIdsOf } from '../src/view.js';

/**
 * The register's central distinction, from both seats.
 *
 * An edge is ONE object with two parties, and it arrives at both of them as `kind: 'edge'`.
 * `isWaiting(item)` was `item.kind === 'expectation'`, so nothing in the ledger ever read the
 * role: Ana promises Boyan something and he confirms it, and **Boyan's screen then says "You
 * owe"** — with `Let it go` (release, the act of the party who is OWED) sitting under that
 * heading. `You are waiting` was empty on both screens, and structurally could hold only
 * expectations, which by M-1 are exactly the promises nobody has signed.
 *
 * It survived because the stand-in could not expose it. `FixtureNodeClient.open_loops` was
 * `input.view === 'all' ? this.state.items : this.state.items` — a ternary with one expression
 * in both branches — so every test in this package ran against a node that never bucketed. And
 * `makeFixture` made every waiting item an `expectation`, which is the single shape where `kind`
 * does imply the role. The fixture agreed with the bug about what a register looks like.
 *
 * The node was never confused. `itemsFor` computes `isOwner` and fills `view: 'owe'` and
 * `view: 'waiting'` correctly; the client asked for `view: 'all'`, which flattens the role away,
 * and then answered the question itself.
 */

const NOW = '2026-08-03T09:00:00Z';

const OWED_TO_ME: OpenLoopItem = {
  kind: 'edge',
  id: 'edge-they-owe-me',
  intent_or_expect: 'Send the signed lease addendum',
  counterparty: { value: 'Maria Ivanova', origin: 'attested' },
  verification_level: '2',
  age_days: 4,
  due: '2026-08-01T09:00:00Z',
  state: 'open',
  actions: [{ act: 'release', tool: 'act', args: { id: 'edge-they-owe-me', act: 'release' } }],
};

const I_OWE: OpenLoopItem = {
  ...OWED_TO_ME,
  id: 'edge-i-owe',
  actions: [{ act: 'done', tool: 'act', args: { id: 'edge-i-owe', act: 'done' } }],
};

const out = (items: OpenLoopItem[]): OpenLoopsOutput => ({ items });

describe('an edge reaches both parties as the same kind, and the register still knows which is which', () => {
  const buckets = { owe: out([I_OWE]), waiting: out([OWED_TO_ME]), closed: out([]) };

  it('puts a promise made TO you under “you are waiting”, not under “you owe”', () => {
    const ledger = buildLedger(buckets, NOW);
    const section = (id: string) =>
      ledger.sections.find((s) => s.id === id)?.cards.map((c) => c.id) ?? [];

    expect(section('waiting')).toEqual(['edge-they-owe-me']);
    expect(section('owe')).toEqual(['edge-i-owe']);
  });

  it('and says whose date it was — “their” date, not yours', () => {
    // The consequence sentence turns on the same role. Told under the wrong heading it also
    // named the wrong person's failing: Boyan read that HE was late for a promise Ana owes him.
    const ledger = buildLedger(buckets, NOW);
    const card = (id: string) =>
      ledger.sections.flatMap((s) => s.cards).find((c) => c.id === id);

    expect(card('edge-they-owe-me')?.ifIDoNothing).toMatch(/^Their date/);
    expect(card('edge-i-owe')?.ifIDoNothing).toMatch(/^The date/);
  });

  it('counts the brief the same way, from the same source', () => {
    const brief = buildBrief(
      {
        generated_at: NOW,
        slots: [
          { headline: 'x', item_id: 'edge-i-owe', primary_action: null },
          { headline: 'y', item_id: 'edge-they-owe-me', primary_action: null },
        ],
        below_the_line_count: 0,
      },
      out([I_OWE, OWED_TO_ME]),
      NOW,
      waitingIdsOf(buckets),
    );
    expect(brief.counts).toEqual({ owe: 1, waiting: 1 });
  });
});

describe('the stand-in node answers the view it was asked for', () => {
  it('gives three different answers to the three views', async () => {
    const fixture = makeFixture(24, NOW);
    const client = new FixtureNodeClient(fixture);

    const owe = await client.open_loops({ view: 'owe', persona: null, limit: 500 });
    const waiting = await client.open_loops({ view: 'waiting', persona: null, limit: 500 });
    const closed = await client.open_loops({ view: 'closed', persona: null, limit: 500 });

    // Disjoint, non-empty, and together they are every live-or-closed item. A stand-in that
    // returned `items` for all three passed every assertion this package had.
    expect(owe.items.length).toBeGreaterThan(0);
    expect(waiting.items.length).toBeGreaterThan(0);
    expect(closed.items.length).toBeGreaterThan(0);

    const ids = [owe, waiting, closed].flatMap((o) => o.items.map((i) => i.id));
    expect(new Set(ids).size, 'the three views overlap').toBe(ids.length);
  });

  it('and the waiting view carries edges, not only expectations', async () => {
    // The case that broke in production. A fixture of expectations alone cannot reach it,
    // because `kind === 'expectation'` is right for exactly those.
    const client = new FixtureNodeClient(makeFixture(24, NOW));
    const waiting = await client.open_loops({ view: 'waiting', persona: null, limit: 500 });
    expect(waiting.items.some((i) => i.kind === 'edge')).toBe(true);
  });

  it('so a whole app view never files a promise made to you under what you owe', async () => {
    const client = new FixtureNodeClient(makeFixture(24, NOW));
    const view = await loadApp(client, { surface: 'owe', now: NOW });

    const waitingIds = new Set(
      (await client.open_loops({ view: 'waiting', persona: null, limit: 500 })).items.map((i) => i.id),
    );
    const oweCards = view.ledger.sections.find((s) => s.id === 'owe')?.cards ?? [];
    expect(oweCards.filter((c) => waitingIds.has(c.id))).toEqual([]);
    expect(oweCards.length).toBeGreaterThan(0);
  });
});
