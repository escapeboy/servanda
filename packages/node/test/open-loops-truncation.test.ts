import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenLoopsInput } from '@servanda/types';
import { makeFixture, type Fixture } from './support/fixture.js';

/**
 * §7 `open_loops`: what a register looks like after a year of use.
 *
 * `limit` is `.max(500)` in the input schema and the output carried nothing but `items`, so a
 * conforming client could neither read a register with more than 500 open loops nor **tell that
 * it had been cut off** — the only available signal was "I got back exactly what I asked for",
 * which is a guess, and 500 is the largest number the schema permits anyone to ask for. Meanwhile
 * `brief`, which IS ranked, cheerfully reported "894 more, further down" about a list that had no
 * further down.
 *
 * And what did come back was `listEdgeIds` order — a directory listing, so edge-id hash order —
 * sliced. An arbitrary subset, in an order carrying no meaning, from the tool a person reads
 * their whole register through.
 */

let fx: Fixture;

/**
 * Enough to truncate, and no more.
 *
 * The first version of this wrote 520 commitments to get past the schema's 500 ceiling — 520 git
 * commits, which starved the vitest worker RPC and produced the `Timeout calling "onTaskUpdate"`
 * the config documents at length. It bought nothing: what makes truncation observable is
 * `total > limit`, and `limit` is any positive integer. That the ceiling is 500 is a fact about
 * the schema and is asserted as one below, with no data at all.
 */
const N = 30;
const PAGE = 10;

beforeAll(() => {
  // `makeFixture` already creates its vault at ARGON2ID_CONSTRAINED — the default is m = 1 GiB
  // and a forgetful test does not fail, it takes minutes and surfaces as a vitest worker timeout
  // that reads as an unrelated flake.
  fx = makeFixture();
  const persona = fx.personas[0]!;
  for (let i = 0; i < N; i++) {
    fx.node.commit({
      intent: `promise ${i}`,
      owed_to: null,
      // A spread of dates so the ranking has something to say. Overdue, due soon, and undated all
      // occur, which is what makes "ranked" different from "in some order".
      due: i % 3 === 0 ? null : new Date(fx.now.getTime() + ((i % 40) - 20) * 86_400_000).toISOString(),
      persona,
      propose: false,
    });
  }
});
afterAll(() => fx.cleanup());

describe('a register larger than one page says so', () => {
  it('reports how many there are, not how many it returned', () => {
    const page = fx.node.openLoops({ persona: null, view: 'all', limit: PAGE });
    expect(page.items).toHaveLength(PAGE);
    expect(page.total).toBe(N);
    // The whole point: the two numbers differ, and a client can see that they differ.
    expect(page.total).toBeGreaterThan(page.items.length);
  });

  it('and still reports it when nothing was truncated', () => {
    // `total === items.length` is not "no total needed". A client that only trusted the field
    // when it disagreed would be back to inferring truncation from the page size.
    const page = fx.node.openLoops({ persona: null, view: 'closed', limit: 500 });
    expect(page.total).toBe(page.items.length);
  });

  it('returns the highest-ranked items, not the first ones the filesystem listed', () => {
    // The ordering claim, checked against `brief` rather than against a restatement of `rank`:
    // §7 says both surfaces order by the same attention market, so `brief`'s leading slot must
    // be reachable in `open_loops`'s first page. A page of 3 out of 30 leaves little room for
    // luck; under storage order this was a 1-in-10 coincidence rather than a property.
    const page = fx.node.openLoops({ persona: null, view: 'all', limit: 3 });
    const brief = fx.node.brief({ persona: null });
    const top = brief.slots[0]!.item_id;
    expect(page.items.map((i) => i.id)).toContain(top);
  });

  it('is a total order, so two identical calls agree', () => {
    // Ties break on id. Without that, two equally-ranked items could swap between calls and a
    // person's register would reshuffle under them for no reason they could see.
    const a = fx.node.openLoops({ persona: null, view: 'all', limit: 500 });
    const b = fx.node.openLoops({ persona: null, view: 'all', limit: 500 });
    expect(a.items).toHaveLength(N);
    expect(a.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id));
  });

  it('and a smaller page is a prefix of a larger one', () => {
    // What "ranked then sliced" means, and what hash-order-then-slice could not give: asking for
    // less gets you the same items, not different ones.
    const small = fx.node.openLoops({ persona: null, view: 'all', limit: 5 });
    const large = fx.node.openLoops({ persona: null, view: 'all', limit: 20 });
    expect(large.items.slice(0, 5).map((i) => i.id)).toEqual(small.items.map((i) => i.id));
  });

  it('and 500 really is the largest page anyone may ask for', () => {
    // Which is why `total` has to exist: past this point there is no bigger request to make, so
    // "I got back what I asked for" is the only signal a client would otherwise have, and it
    // cannot distinguish a full register from a truncated one.
    expect(OpenLoopsInput.safeParse({ view: 'all', persona: null, limit: 501 }).success).toBe(false);
    expect(OpenLoopsInput.safeParse({ view: 'all', persona: null, limit: 500 }).success).toBe(true);
  });
});
