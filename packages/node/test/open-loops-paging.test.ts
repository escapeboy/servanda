import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenLoopsInput, OpenLoopsOutput } from '@servanda/types';
import { NodeError } from '../src/node.js';
import { makeFixture, nodeAs, syncEdge, type Fixture } from './support/fixture.js';

/**
 * §7 `open_loops`, page two.
 *
 * `total` told a client that its register was cut off and gave it no way to read the rest: `limit`
 * is capped at 500 and 500 is the largest number anyone may ask for, so a register of 3000 loops
 * was 500 readable ones and an integer saying "there are 2500 more, somewhere". §7 declined a
 * cursor on purpose and said why — "a stable order under insertion, cursor expiry, items removed
 * mid-page" — which is the right list of hazards and the wrong conclusion to draw from it: the
 * hazards do not go away when the cursor does, they land on the person instead.
 *
 * The cursor here is a KEYSET over the ranking, with the ranking instant frozen into it. What that
 * buys is stated as three tests below, one per hazard, because a cursor that cannot say which of
 * them it survives is worse than an offset.
 */

const N = 21;
const PAGE = 7;

let fx: Fixture;

beforeAll(() => {
  // `makeFixture` derives at ARGON2ID_CONSTRAINED. One vault, 21 commitments — a commitment is a
  // git commit, and 500 of them starve the vitest worker RPC. Nothing here needs 500: what makes
  // paging observable is `total > limit`, and `limit` is any positive integer.
  fx = makeFixture();
  for (let i = 0; i < N; i++) {
    fx.node.commit({
      intent: `promise ${i}`,
      owed_to: null,
      // Overdue, due-soon and undated all occur, so the ranking has bands to separate and the
      // page boundary falls somewhere non-trivial.
      due: i % 3 === 0 ? null : new Date(fx.now.getTime() + ((i % 40) - 20) * 86_400_000).toISOString(),
      persona: null,
      propose: false,
    });
  }
});
afterAll(() => fx.cleanup());

/** Walk the whole register through the cursor, page by page. */
function walk(limit = PAGE): { ids: string[]; pages: number; skipped: number } {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let skipped = 0;
  for (;;) {
    const page: OpenLoopsOutput = fx.node.openLoops({ persona: null, view: 'all', limit, cursor });
    ids.push(...page.items.map((i) => i.id));
    skipped += page.skipped;
    pages++;
    if (page.next_cursor === null) break;
    cursor = page.next_cursor;
    if (pages > 100) throw new Error('the cursor did not terminate');
  }
  return { ids, pages, skipped };
}

describe('§7 open_loops: a register larger than one page can be read to the end', () => {
  it('the schema carries the cursor in both directions', () => {
    // Both halves, because either one alone is unusable: an input with nowhere to get a cursor
    // from, or an output whose cursor nothing accepts.
    expect(OpenLoopsInput.safeParse({ view: 'all', persona: null, limit: 50, cursor: null }).success).toBe(true);
    const parsed = OpenLoopsInput.parse({});
    expect(parsed.cursor).toBeNull();
    expect(
      OpenLoopsOutput.safeParse({ items: [], total: 0, next_cursor: null, skipped: 0 }).success,
    ).toBe(true);
  });

  it('walks the entire register in pages, exactly once each', () => {
    const { ids, pages } = walk();
    expect(ids).toHaveLength(N);
    expect(new Set(ids).size).toBe(N);
    expect(pages).toBe(Math.ceil(N / PAGE));
  });

  it('and the walk is the same order a single unpaged read gives', () => {
    // The whole claim of a keyset cursor: paging does not reorder. If these differ, the cursor is
    // reading a different list from the one §7 says `open_loops` returns.
    const whole = fx.node.openLoops({ persona: null, view: 'all', limit: 500, cursor: null });
    expect(walk().ids).toEqual(whole.items.map((i) => i.id));
  });

  it('says the register is finished by handing back no cursor, not an empty page', () => {
    const last = fx.node.openLoops({ persona: null, view: 'all', limit: 500, cursor: null });
    expect(last.items).toHaveLength(N);
    expect(last.next_cursor).toBeNull();
    // And the first page of a longer register says the opposite, so `null` means something.
    expect(fx.node.openLoops({ persona: null, view: 'all', limit: PAGE, cursor: null }).next_cursor).not.toBeNull();
  });

  it('reports `total` on every page, not just the first', () => {
    let cursor: string | null = null;
    for (let i = 0; i < 3; i++) {
      const page: OpenLoopsOutput = fx.node.openLoops({ persona: null, view: 'all', limit: PAGE, cursor });
      expect(page.total).toBe(N);
      cursor = page.next_cursor;
    }
  });

  it('a page size may change mid-walk without losing or repeating anything', () => {
    const first = fx.node.openLoops({ persona: null, view: 'all', limit: 3, cursor: null });
    const rest = fx.node.openLoops({ persona: null, view: 'all', limit: 500, cursor: first.next_cursor });
    const whole = fx.node.openLoops({ persona: null, view: 'all', limit: 500, cursor: null });
    expect([...first.items, ...rest.items].map((i) => i.id)).toEqual(whole.items.map((i) => i.id));
  });
});

/**
 * The three hazards §7 named as reasons not to have a cursor, each taken in turn.
 *
 * None of them is a reason not to have one. Two are survived exactly; the third cannot be survived
 * by any cursor a node does not keep state for, and is COUNTED rather than hidden.
 */
describe('§7 open_loops: what the cursor survives, said out loud', () => {
  /**
   * ONE vault for all four, and the three that mutate it run in order.
   *
   * The first version stood up a fixture per case: four Argon2id derivations and four git
   * repositories in a file that already had one, and the node suite began emitting the
   * `Timeout calling "onTaskUpdate"` worker-RPC failure `vitest.config.ts` documents at length —
   * a red result invented by the harness, which is the worst kind. Nothing here needed a second
   * vault: five overdue commitments rank above one undated edge whatever the hashes are, so the
   * page boundary is deterministic and every case can take the register as the one before it left
   * it. Where a case mutates, it says so.
   */
  let hz: Fixture;
  let edge: string;

  beforeAll(() => {
    hz = makeFixture();
    // `BAND_OVERDUE` is above `BAND_UNDATED`, so these five sort above the edge — page one of four
    // cannot contain it, whatever the ids hash to.
    for (let i = 0; i < 5; i++) {
      hz.node.commit({
        intent: `overdue ${i}`,
        owed_to: null,
        due: new Date(hz.now.getTime() - (i + 1) * 86_400_000).toISOString(),
        persona: null,
        propose: false,
      });
    }
    const { edge_id } = hz.node.commit({
      intent: 'the one that changes state mid-walk',
      owed_to: hz.personas[1]!,
      due: null,
      persona: null,
      propose: true,
    });
    if (edge_id === null) throw new Error('the fixture failed to propose');
    edge = edge_id;
    syncEdge(hz, 0, 1, edge);
    nodeAs(hz, 1).confirm({ id: edge, decision: 'confirm' });
    syncEdge(hz, 1, 0, edge);
  });
  afterAll(() => hz.cleanup());

  it('an item DELETED between pages: no skip, no repeat', () => {
    // The failure mode that kills offset paging. Under `LIMIT/OFFSET` a removal above the cursor
    // slides one unread item up past it and it is never returned — silently, and the client cannot
    // tell. A keyset is defined by the last item's rank, so a removal above it moves nothing.
    //
    // The removal is §5.4 retention, not a test-only door: M-15 deletes the plaintext, the record
    // leaves `listCommitments`, and the item leaves every view. A register being paged while the
    // retention sweep runs is the ordinary case, not a contrived one.
    //
    // Run on the shared 21-item register rather than on `hz`, because it destroys what it deletes.
    const first = fx.node.openLoops({ persona: null, view: 'all', limit: PAGE, cursor: null });
    const doomed = first.items[1]!.id;
    expect(fx.vault.deleteCommitmentPlaintext(fx.personas[0]!, doomed)).toBe(true);

    const rest = fx.node.openLoops({ persona: null, view: 'all', limit: 500, cursor: first.next_cursor });
    const seen = [...first.items, ...rest.items].map((i) => i.id);
    expect(new Set(seen).size).toBe(seen.length); // nothing twice
    const remaining = fx.node
      .openLoops({ persona: null, view: 'all', limit: 500, cursor: null })
      .items.map((i) => i.id);
    // Everything that still exists was delivered — the deleted one having been delivered already.
    for (const id of remaining) expect(seen).toContain(id);
    expect(rest.skipped).toBe(0);
  });

  it('an item whose STATE changes between pages: still delivered exactly once, in place', () => {
    // The hazard §7 would have written as "reordering", because it looks like reordering. It is
    // not. Rank is a function of (`since`, `due`, `blocking_count`, `now`) and of nothing else —
    // `OrderingKey` carries a `state`, and `rank` does not read it — so an item's position cannot
    // move because its state moved. What a state change does is move an item between VIEWS, which
    // inside one view is the deletion above and inside `view:"all"` is nothing at all.
    const before = hz.node.openLoops({ persona: null, view: 'all', limit: 500, cursor: null });
    expect(before.items[before.items.length - 1]!.id).toBe(edge);
    expect(before.items.find((i) => i.id === edge)!.state).toBe('open');

    const first = hz.node.openLoops({ persona: null, view: 'all', limit: 4, cursor: null });
    // The counterparty forgives the debt while the reader is between pages. Terminal, and the
    // item has not been delivered yet.
    expect(nodeAs(hz, 1).act({ id: edge, act: 'release', evidence_hash: null }).accepted).toBe(true);
    syncEdge(hz, 1, 0, edge);

    const rest = hz.node.openLoops({ persona: null, view: 'all', limit: 500, cursor: first.next_cursor });
    const seen = [...first.items, ...rest.items];
    expect(seen.map((i) => i.id)).toEqual(before.items.map((i) => i.id));
    expect(rest.skipped).toBe(0);
    // Delivered once, in the same position, carrying its NEW state — which is the honest outcome:
    // the reader is not shown a stale row, and is not shown two rows either.
    expect(seen[seen.length - 1]!.state).toBe('released');
  });

  it('and the ranking instant is frozen, so a moving clock does not move the boundary', () => {
    // The member that does the work. Without it every item ages between page one and page two,
    // every score changes, and the boundary drifts under the reader for no reason they could see.
    // `age_days` is the observable: an item on page two is aged as of when the WALK began.
    //
    // Leaves the clock ten minutes ahead, which the case below inherits.
    const whole = hz.node.openLoops({ persona: null, view: 'all', limit: 500, cursor: null });
    const first = hz.node.openLoops({ persona: null, view: 'all', limit: 4, cursor: null });

    // Ten minutes, which is inside `CURSOR_TTL` — beyond it the cursor is refused rather than
    // honoured, which is the other half of the same rule.
    hz.setNow(new Date(hz.now.getTime() + 600_000));
    const rest = hz.node.openLoops({ persona: null, view: 'all', limit: 500, cursor: first.next_cursor });
    expect([...first.items, ...rest.items].map((i) => i.id)).toEqual(whole.items.map((i) => i.id));

    const resumed = rest.items[0]!;
    const atStart = whole.items.find((i) => i.id === resumed.id)!;
    expect(resumed.age_days).toBe(atStart.age_days);
    // And a fresh read at the new instant really does differ, so the equality above is the freeze
    // working and not two identical clocks.
    const fresh = hz.node.openLoops({ persona: null, view: 'all', limit: 500, cursor: null });
    expect(fresh.items.find((i) => i.id === resumed.id)!.age_days).toBeGreaterThan(resumed.age_days);
  });

  it('an item INSERTED above the cursor: not delivered, and SAID so rather than dropped', () => {
    // The one hazard a stateless cursor cannot survive, so it is reported. An item that sorts above
    // where the reader has already passed will not appear in any later page of this walk — that is
    // true of every keyset cursor ever written, and the difference between an honest one and a
    // dishonest one is whether the reader is told.
    const first = hz.node.openLoops({ persona: null, view: 'all', limit: 4, cursor: null });
    // Overdue by a month, where the register's oldest is overdue by five days: `BAND_OVERDUE` with
    // the heaviest weight in it, so it sorts above everything the reader has already passed.
    hz.node.commit({
      intent: 'arrived while you were reading',
      owed_to: null,
      due: new Date(hz.now.getTime() - 30 * 86_400_000).toISOString(),
      persona: null,
      propose: false,
    });
    const next = hz.node.openLoops({ persona: null, view: 'all', limit: 4, cursor: first.next_cursor });
    expect(next.skipped).toBe(1);
    expect(next.total).toBe(7);
    // And it really is absent from the rest of the walk — the count is not decoration.
    let cursor: string | null = first.next_cursor;
    const rest: string[] = [];
    while (cursor !== null) {
      const page: OpenLoopsOutput = hz.node.openLoops({ persona: null, view: 'all', limit: 4, cursor });
      rest.push(...page.items.map((i) => i.id));
      cursor = page.next_cursor;
    }
    expect(rest).toHaveLength(2);
  });
});

describe('§7 open_loops: a cursor that cannot be trusted is refused, never guessed at', () => {
  it('refuses a cursor issued for a different view', () => {
    // The order and the membership are both a function of the view. Replaying an `owe` cursor
    // against `closed` would return a page of the closed register positioned by a rank from the
    // owe register — arbitrary, and indistinguishable from a correct answer.
    const owe = fx.node.openLoops({ persona: null, view: 'owe', limit: 3, cursor: null });
    expect(() =>
      fx.node.openLoops({ persona: null, view: 'closed', limit: 3, cursor: owe.next_cursor }),
    ).toThrow(NodeError);
  });

  it('refuses a cursor that is not one', () => {
    expect(() => fx.node.openLoops({ persona: null, view: 'all', limit: 3, cursor: 'nonsense' })).toThrow(
      NodeError,
    );
  });

  it('refuses a cursor older than the ranking it froze', () => {
    // Cursor expiry, which §7 named as a hazard and which is only a hazard if it is silent. The
    // instant is frozen so the walk is one read; a walk resumed a day later would rank a day-old
    // register and present it as current, so it is refused and the client re-reads from the top.
    const first = fx.node.openLoops({ persona: null, view: 'all', limit: 3, cursor: null });
    const before = fx.now;
    try {
      fx.setNow(new Date(before.getTime() + 86_400_000));
      expect(() =>
        fx.node.openLoops({ persona: null, view: 'all', limit: 3, cursor: first.next_cursor }),
      ).toThrow(NodeError);
    } finally {
      fx.setNow(before);
    }
  });
});
