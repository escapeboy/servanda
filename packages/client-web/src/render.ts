import { COPY } from './copy.js';
import type { El } from './element.js';
import { el, textEl } from './element.js';
import type { BriefView, CardView, InboxView, LedgerView } from './view.js';

/**
 * View model → element tree.
 *
 * A register is a list, so it is rendered as one: `ul`/`li`, real headings, real buttons.
 * Leaning on native semantics is the cheapest accessibility that exists and the only kind
 * that keeps working when someone later changes the styling.
 *
 * Action before description: the buttons come first in document order, so the primary
 * action is both the first thing Tab reaches and the first thing a screen reader announces
 * inside the card.
 */

export type SurfaceId = 'brief' | 'owe' | 'waiting' | 'closed' | 'inbox';

function actionsOf(card: CardView): El {
  return el(
    'div',
    { class: 'card-actions' },
    card.actions.map((action) =>
      textEl('button', action.label, {
        type: 'button',
        class: action.primary ? 'action action-primary' : 'action',
        'data-action': action.id,
      }),
    ),
  );
}

/**
 * M-12 in one place: the seal's relief and the words for the evidence level are emitted
 * together with the name, from the same values, in the same paragraph. There is no branch
 * that renders a name and omits what stands behind it.
 */
function withWhomOf(card: CardView): El {
  const seal = el('span', {
    class: `seal seal-${card.seal.shape}`,
    role: 'img',
    'aria-label': card.seal.label,
  });
  if (card.withWhom === null) {
    // Not a name, so there is no evidence level to display beside it (M-12 is about names).
    return el('p', { class: 'with' }, [
      seal,
      textEl('span', COPY.party.justYou, { class: 'party party-self' }),
    ]);
  }
  return el('p', { class: 'with' }, [
    seal,
    textEl('span', card.withWhom.display, {
      class: card.withWhom.isKey ? 'party party-key' : 'party',
    }),
    textEl('span', card.withWhom.trust.label, {
      class: `trust relief-${card.withWhom.trust.relief}`,
      'data-level': card.withWhom.trust.level,
    }),
  ]);
}

export function cardEl(card: CardView): El {
  return el('li', { class: 'card', 'data-card': card.id }, [
    actionsOf(card),
    textEl('p', card.what, { class: 'what' }),
    withWhomOf(card),
    textEl('p', card.ifIDoNothing, { class: `consequence tone-${card.tone}` }),
  ]);
}

function cardsEl(cards: readonly CardView[], empty: string): El {
  if (cards.length === 0) return textEl('p', empty, { class: 'empty' });
  return el('ul', { class: 'cards' }, cards.map(cardEl));
}

export function navEl(current: SurfaceId): El {
  const items: { id: SurfaceId; label: string }[] = [
    { id: 'brief', label: COPY.nav.brief },
    { id: 'owe', label: COPY.nav.owe },
    { id: 'waiting', label: COPY.nav.waiting },
    { id: 'closed', label: COPY.nav.closed },
    { id: 'inbox', label: COPY.nav.inbox },
  ];
  return el(
    'nav',
    { 'aria-label': COPY.appName },
    items.map(({ id, label }) =>
      textEl('button', label, {
        type: 'button',
        class: id === current ? 'nav-item nav-current' : 'nav-item',
        'data-surface': id,
        'aria-current': id === current ? 'page' : false,
      }),
    ),
  );
}

export function briefEl(brief: BriefView): El {
  return el('section', { 'aria-labelledby': 'brief-heading', class: 'surface' }, [
    textEl('h1', brief.heading, { id: 'brief-heading' }),
    textEl('p', brief.generatedLine, { class: 'generated' }),
    cardsEl(brief.cards, brief.empty),
    ...(brief.belowTheLine === null
      ? []
      : [textEl('p', brief.belowTheLine, { class: 'below-the-line' })]),
  ]);
}

export function ledgerEl(ledger: LedgerView, only?: 'owe' | 'waiting' | 'closed'): El {
  const sections = ledger.sections.filter((s) => only === undefined || s.id === only);
  return el(
    'section',
    { class: 'surface' },
    sections.flatMap((section) => [
      textEl('h2', section.heading, { id: `section-${section.id}` }),
      cardsEl(section.cards, section.empty),
    ]),
  );
}

export function inboxEl(inbox: InboxView): El {
  return el('section', { 'aria-labelledby': 'inbox-heading', class: 'surface' }, [
    textEl('h1', inbox.heading, { id: 'inbox-heading' }),
    textEl('p', inbox.consequence, { class: 'generated' }),
    cardsEl(inbox.cards, inbox.empty),
  ]);
}

export interface AppView {
  readonly surface: SurfaceId;
  readonly brief: BriefView;
  readonly ledger: LedgerView;
  readonly inbox: InboxView;
}

/** The whole surface: navigation plus whichever view is showing. */
export function appEl(app: AppView): El {
  const body =
    app.surface === 'brief'
      ? briefEl(app.brief)
      : app.surface === 'inbox'
        ? inboxEl(app.inbox)
        : ledgerEl(app.ledger, app.surface);
  return el('main', { id: 'servanda', class: 'servanda' }, [navEl(app.surface), body]);
}
