import { z } from 'zod';
import { OpenLoopsView, PROTOCOL_VERSION } from '@servanda/types';
import { addDuration } from './duration.js';

/**
 * §7 `open_loops` paging — the cursor, and what it is willing to promise.
 *
 * A KEYSET, not an offset: a page resumes at the first item ranking strictly below the last one
 * delivered, so nothing between them can shift the boundary. And the ranking INSTANT is frozen
 * into the cursor, which is the member that does the real work.
 *
 * Rank is a function of (`since`, `due`, `blocking_count`, `now`) and of nothing else — notably
 * not of state. So with `now` held still for the whole walk, an item's position cannot move at
 * all: not because time passed, and not because somebody signed something. That collapses two of
 * the three hazards §7 named into the third:
 *
 *  - **an item deleted mid-walk** moves nothing, because the boundary is a rank and not a count.
 *    (Under `LIMIT/OFFSET` this is the bad one: a removal above the cursor slides an unread item
 *    up past it, silently, and the client cannot tell.)
 *  - **an item that expires mid-walk** does not reorder the register; it leaves one view and joins
 *    another, which inside a single view is the case above.
 *  - **an item inserted above the cursor** is the one that cannot be survived without per-reader
 *    state. It is COUNTED instead (`skipped`), because the alternative — dropping it in silence —
 *    is precisely what makes an opaque cursor worse than an honest offset.
 *
 * The freeze is what makes cursor expiry a real obligation rather than a nicety: a walk resumed
 * tomorrow would rank yesterday's register and present it as current, so the node refuses.
 */

/**
 * How long a cursor stays valid.
 *
 * Local policy, not a protocol constant, and nothing signs it — unlike `dispute_window`, no party
 * gains by a cursor living longer. It is short because the value of a frozen instant is that it
 * is nearly `now`: fifteen minutes is longer than any paging walk and shorter than the fourteen
 * days `DUE_SOON_HORIZON_DAYS` divides, so no item can cross a ranking band inside one.
 */
export const CURSOR_TTL = 'PT15M';

export const PageCursor = z
  .object({
    /** A cursor minted under another protocol version is refused, not reinterpreted. */
    v: z.literal(PROTOCOL_VERSION),
    /** Both are part of the identity of the list: a cursor is meaningless against another one. */
    view: OpenLoopsView,
    persona: z.string().min(1),
    /** The frozen ranking instant. Every page of the walk ranks as of this. */
    as_of: z.string().min(1),
    /** The rank of the last item delivered — score first, id to break the tie. */
    score: z.number(),
    id: z.string().min(1),
    /**
     * How many items sorted above this key when the cursor was issued.
     *
     * Not "how many were delivered", though on an unchanging register the two are the same number.
     * It is stored as a property of the KEY so that a later page comparing against it measures the
     * same thing — otherwise an insertion above the cursor is re-reported on every subsequent page.
     */
    above: z.number().int().nonnegative(),
  })
  .strict();
export type PageCursor = z.infer<typeof PageCursor>;

export class CursorError extends Error {
  override name = 'CursorError';
}

export function encodeCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Decode and validate, or throw. There is no lenient path: a cursor a node cannot verify is a
 * cursor it cannot position, and positioning it wrongly skips items without saying so.
 */
export function decodeCursor(raw: string): PageCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new CursorError('§7: not a cursor this node issued');
  }
  const result = PageCursor.safeParse(parsed);
  if (!result.success) throw new CursorError('§7: not a cursor this node issued');
  return result.data;
}

/** Has this cursor outlived the instant it froze? */
export function cursorExpired(cursor: PageCursor, now: Date): boolean {
  return now.getTime() > addDuration(new Date(Date.parse(cursor.as_of)), CURSOR_TTL).getTime();
}

/**
 * Does an item at (`score`, `id`) come after the cursor's key?
 *
 * The register is ordered by score DESCENDING with the id ascending as the tiebreak, so "after"
 * is lower score, or equal score and a larger id. One function, used both to position a page and
 * to count what overtook the reader, so the two can never disagree.
 */
export function sortsAfter(cursor: PageCursor, score: number, id: string): boolean {
  return score < cursor.score || (score === cursor.score && id > cursor.id);
}
