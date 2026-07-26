import { COPY } from './copy.js';
import type { AppView, SurfaceId } from './render.js';
import { STANDALONE_SURFACES } from './render.js';
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
  { id: 'team', label: COPY.nav.team },
  { id: 'trust', label: COPY.nav.trust },
];

function cardsShowing(app: AppView): readonly CardView[] {
  if (app.surface === 'brief') return app.brief.cards;
  if (app.surface === 'inbox') return app.inbox.cards;
  return app.ledger.sections.find((s) => s.id === app.surface)?.cards ?? [];
}

/**
 * Stops that do not come from a card: the source controls on Integrations & Trust, the
 * consent on a proof page, the two controls of the recovery sheet. The team surface
 * contributes none — it is a read, not a console.
 */
function loneStops(app: AppView): Stop[] {
  if (app.surface === 'trust') {
    return app.integrations.sources.map((source) => ({
      id: source.action.id,
      label: source.action.label,
      kind: 'action' as const,
      cardId: source.id,
    }));
  }
  if (app.surface === 'proof') {
    return (app.proof?.actions ?? []).map((action) => ({
      id: action.id,
      label: action.label,
      kind: 'action' as const,
    }));
  }
  if (app.surface === 'first-run') {
    const steps = app.onboarding.steps.flatMap((step) => (step.action === null ? [] : [step.action]));
    return [...steps, ...app.onboarding.recovery.actions].map((action) => ({
      id: action.id,
      label: action.label,
      kind: 'action' as const,
    }));
  }
  return [];
}

export function stopsFor(app: AppView): Stop[] {
  // A standalone surface has no navigation to walk: a proof page is a link someone sent
  // you, and first run happens before there is anything to navigate between.
  const standalone = STANDALONE_SURFACES.includes(app.surface);
  const stops: Stop[] = standalone
    ? []
    : SURFACES.map(({ id, label }) => ({ id, label, kind: 'surface' }));
  for (const card of cardsShowing(app)) {
    for (const action of card.actions) {
      stops.push({ id: action.id, label: action.label, kind: 'action', cardId: card.id });
    }
  }
  stops.push(...loneStops(app));
  return stops;
}
