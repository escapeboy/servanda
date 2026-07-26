import { COPY } from './copy.js';
import type { AppView, SurfaceId } from './render.js';
import type { CardView } from './view.js';

/**
 * Everything a person can reach, in the order they reach it — derived from the view model,
 * not from any one rendering.
 *
 * This is what makes "full parity via the same five tools" checkable rather than asserted:
 * the browser's Tab order and the terminal's cursor walk are both required to equal this
 * list, so a control that exists in one surface and not the other is a test failure.
 */

export interface Stop {
  readonly id: string;
  readonly label: string;
  readonly kind: 'surface' | 'action';
  /** For action stops, the card the action belongs to. */
  readonly cardId?: string;
}

export const SURFACES: readonly { id: SurfaceId; label: string }[] = [
  { id: 'brief', label: COPY.nav.brief },
  { id: 'owe', label: COPY.nav.owe },
  { id: 'waiting', label: COPY.nav.waiting },
  { id: 'closed', label: COPY.nav.closed },
  { id: 'inbox', label: COPY.nav.inbox },
];

function cardsShowing(app: AppView): readonly CardView[] {
  if (app.surface === 'brief') return app.brief.cards;
  if (app.surface === 'inbox') return app.inbox.cards;
  return app.ledger.sections.find((s) => s.id === app.surface)?.cards ?? [];
}

export function stopsFor(app: AppView): Stop[] {
  const stops: Stop[] = SURFACES.map(({ id, label }) => ({ id, label, kind: 'surface' }));
  for (const card of cardsShowing(app)) {
    for (const action of card.actions) {
      stops.push({ id: action.id, label: action.label, kind: 'action', cardId: card.id });
    }
  }
  return stops;
}
