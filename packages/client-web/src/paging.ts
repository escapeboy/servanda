import type { NodeClient } from './node-client.js';
import type { OpenLoopItem, OpenLoopsOutput, OpenLoopsView } from '@servanda/types';

/**
 * Read a whole view, not the first page of it.
 *
 * Every surface in this package used to ask for `limit: 500, cursor: null` and render what came
 * back. `limit` is capped at 500 by §7, so a register of 3000 open things showed 500 of them and
 * said nothing about the other 2500 — the person could not tell a complete register from a
 * truncated one, which is the same failure `total` was added to the node to fix. `total` landed
 * and no client ever read it; `next_cursor` was then added and had no reader either.
 *
 * §7's cursor is a keyset over the rank with the ranking instant FROZEN at the first page, so a
 * walk is stable: an item cannot change position because time passed or because somebody signed
 * something. Two things can still happen, and they are not the same:
 *
 *   - an item is REMOVED mid-walk — the boundary is a rank, not a count, so nothing shifts past
 *     the reader and nothing is missed;
 *   - an item is INSERTED above where the reader has already got to — it will not appear on any
 *     later page of this walk. That is true of every cursor without per-reader state and is not
 *     fixable here. What is fixable is whether the person is TOLD, which is what `skipped` is
 *     for. It is a NET number and therefore a lower bound: an insert and a remove above the
 *     cursor in one interval cancel out.
 */

/** How many pages one walk will take before it stops and says so. */
const MAX_PAGES = 40;

/** §7 caps `limit` at 500; asking for more is refused rather than clamped. */
const PAGE_SIZE = 500;

export interface WalkedView {
  readonly items: readonly OpenLoopItem[];
  /** The view's size as the node reports it — not `items.length`, so the two can disagree. */
  readonly total: number;
  /** Net count of items that ranked above the reader after they had passed. A lower bound. */
  readonly skipped: number;
  readonly pages: number;
  /**
   * The walk hit `MAX_PAGES` and stopped with a cursor still in hand.
   *
   * Reported rather than swallowed. A surface that silently renders 20000 of 30000 items is the
   * defect this module exists to remove, only with a bigger number in it.
   */
  readonly truncated: boolean;
}

export async function walkView(
  client: NodeClient,
  view: OpenLoopsView,
  persona: string | null,
): Promise<WalkedView> {
  const items: OpenLoopItem[] = [];
  let cursor: string | null = null;
  let total = 0;
  let skipped = 0;
  let pages = 0;

  for (;;) {
    const page: OpenLoopsOutput = await client.open_loops({
      view,
      persona,
      limit: PAGE_SIZE,
      cursor,
    });
    pages += 1;
    items.push(...page.items);
    // `total` from the LAST page read, because §7 requires it on every page and the later
    // reading is the fresher one. `skipped` accumulates: each page reports what got ahead of
    // the reader since the cursor was issued, and a walk wants the sum.
    total = page.total;
    skipped += page.skipped;
    cursor = page.next_cursor;
    // `null` is a statement — "the view is finished" — and not an absence. An empty page with a
    // cursor still set is a node saying "keep going", which is why this loop tests the cursor
    // and not `page.items.length`.
    if (cursor === null) return { items, total, skipped, pages, truncated: false };
    if (pages >= MAX_PAGES) return { items, total, skipped, pages, truncated: true };
  }
}

/** The walk as an `OpenLoopsOutput`, for the builders that take one. */
export function asOutput(walked: WalkedView): OpenLoopsOutput {
  return {
    items: [...walked.items],
    total: walked.total,
    next_cursor: null,
    skipped: walked.skipped,
  };
}
