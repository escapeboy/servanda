import { describe, expect, it } from 'vitest';
import type { NodeClient } from '../src/node-client.js';
import type { BriefOutput, OpenLoopItem, OpenLoopsInput, OpenLoopsOutput } from '@servanda/types';
import { FixtureNodeClient, makeFixture } from '../src/fixture-node.js';
import { loadApp } from '../src/index.js';
import { walkView } from '../src/paging.js';
import { appEl } from '../src/render.js';
import { renderToHtml } from '../src/element.js';

const NOW = '2026-03-01T09:00:00Z';

/**
 * A register larger than one page, read to the end.
 *
 * §7 caps `limit` at 500. Every surface in this package asked for exactly that with a null
 * cursor and rendered what came back, so a person with 3000 open things saw 500 of them and was
 * told nothing — the same defect `total` was added to the node to make visible, except that no
 * client ever read `total` either, and then `next_cursor` arrived and had no reader in turn.
 *
 * 1200 items, so the walk is three pages and the arithmetic cannot be satisfied by accident.
 */
const BIG = 1200;

describe('the whole register reaches the screen', () => {
  it('walks every page of a view instead of taking the first', async () => {
    const client = new FixtureNodeClient(makeFixture(BIG, NOW));
    const walked = await walkView(client, 'all', null);

    expect(walked.items).toHaveLength(BIG);
    expect(walked.total).toBe(BIG);
    expect(walked.pages).toBe(3);
    expect(walked.truncated).toBe(false);
  });

  it('and every id exactly once — a walk that repeats a page is as wrong as one that skips', async () => {
    const client = new FixtureNodeClient(makeFixture(BIG, NOW));
    const walked = await walkView(client, 'all', null);
    expect(new Set(walked.items.map((i) => i.id)).size).toBe(BIG);
  });

  it('so the ledger holds the register and not a prefix of it', async () => {
    const client = new FixtureNodeClient(makeFixture(BIG, NOW));
    const app = await loadApp(client, { surface: 'owe', now: NOW });
    const rendered = app.ledger.sections.reduce((n, s) => n + s.cards.length, 0);
    // The three §7 views partition the live/closed register, so their sum is the whole of it.
    expect(rendered).toBe(BIG);
    expect(app.reach.complete).toBe(true);
    expect(app.reach.line).toBeNull();
  });
});

/**
 * A node that hands back a cursor for ever.
 *
 * Not hypothetical: `walkView` asks until told to stop, and "told to stop" is a value the other
 * side controls. A client that trusts it without a ceiling hangs; a client that caps silently
 * shows a prefix and calls it the register, which is the very thing being fixed here. So the cap
 * exists AND it is reported.
 */
class NeverEndingClient implements NodeClient {
  pages = 0;
  constructor(private readonly item: OpenLoopItem) {}
  async commit(): Promise<never> {
    throw new Error('not used');
  }
  async expect(): Promise<never> {
    throw new Error('not used');
  }
  async confirm(): Promise<never> {
    throw new Error('not used');
  }
  async brief(): Promise<BriefOutput> {
    return { generated_at: NOW, slots: [], below_the_line: null };
  }
  async open_loops(_input: OpenLoopsInput): Promise<OpenLoopsOutput> {
    this.pages += 1;
    return {
      items: [{ ...this.item, id: `endless-${this.pages}` }],
      total: 99_999,
      next_cursor: `page-${this.pages}`,
      skipped: 0,
    };
  }
}

describe('a walk that cannot finish says so rather than hanging or lying', () => {
  it('stops at its ceiling and reports the shortfall', async () => {
    const item = makeFixture(1, NOW).items[0]!;
    const client = new NeverEndingClient(item);
    const walked = await walkView(client, 'all', null);

    expect(walked.truncated).toBe(true);
    expect(walked.pages).toBe(40);
    expect(walked.total).toBe(99_999);
    // What it read is what it read — the ceiling bounds the work, it does not fabricate items.
    expect(walked.items).toHaveLength(40);
  });

  it('and the person is told, in words, on the screen', async () => {
    const item = makeFixture(1, NOW).items[0]!;
    const app = await loadApp(new NeverEndingClient(item), { surface: 'owe', now: NOW });

    expect(app.reach.complete).toBe(false);
    expect(app.reach.line).not.toBeNull();
    // Rendered, not merely computed. `brief.unresolved` sat on the view model unrendered long
    // enough for a brief with two unreachable slots to print "Nothing is waiting on you today",
    // and this line exists because of that.
    expect(renderToHtml(appEl(app))).toContain(app.reach.line!);
  });
});

/** `skipped` is the other half: the walk finished, and somebody got ahead of the reader. */
class SkippingClient implements NodeClient {
  private served = 0;
  constructor(private readonly items: readonly OpenLoopItem[]) {}
  async commit(): Promise<never> {
    throw new Error('not used');
  }
  async expect(): Promise<never> {
    throw new Error('not used');
  }
  async confirm(): Promise<never> {
    throw new Error('not used');
  }
  async brief(): Promise<BriefOutput> {
    return { generated_at: NOW, slots: [], below_the_line: null };
  }
  async open_loops(input: OpenLoopsInput): Promise<OpenLoopsOutput> {
    const from = input.cursor === null || input.cursor === undefined ? 0 : Number(input.cursor);
    const page = this.items.slice(from, from + input.limit);
    const next = from + page.length;
    this.served += 1;
    return {
      items: page,
      total: this.items.length,
      next_cursor: next >= this.items.length ? null : String(next),
      // Two arrived above the reader while page two was being served.
      skipped: this.served === 2 ? 2 : 0,
    };
  }
}

describe('what got ahead of the reader is counted, and said as a lower bound', () => {
  it('sums skipped across the walk and puts it on the screen', async () => {
    const items = makeFixture(1100, NOW).items;
    const app = await loadApp(new SkippingClient(items), { surface: 'owe', now: NOW });

    expect(app.reach.skipped).toBeGreaterThan(0);
    // The walk COMPLETED — nothing is missing from the register, one item is not on this screen.
    // Collapsing this into the same flag as truncation would tell somebody who is missing
    // nothing that they are missing something.
    expect(app.reach.complete).toBe(true);
    expect(app.reach.line).toContain('arrived above');
    expect(renderToHtml(appEl(app))).toContain(app.reach.line!);
  });
});
