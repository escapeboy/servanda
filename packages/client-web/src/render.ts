import { COPY } from './copy.js';
import type { El } from './element.js';
import { el, escapeHtml, renderToHtml, textEl } from './element.js';
import { THEME_CSS } from './theme.js';
import type { IntegrationsView, WorkClassView } from './integrations.js';
import type { OnboardingView } from './onboarding.js';
import type { ProofView } from './proof.js';
import type { TeamEntryView, TeamView } from './team.js';
import type { ActionView, BriefView, CardView, InboxView, LedgerView, PartyView } from './view.js';

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

/**
 * The seven views of the one surface, plus the two that stand outside it: the proof page
 * is a public certificate at its own link, and first run happens before there is anything
 * to navigate. Both are rendered without the navigation for that reason.
 */
export type SurfaceId =
  | 'brief'
  | 'owe'
  | 'waiting'
  | 'closed'
  | 'inbox'
  | 'team'
  | 'trust'
  | 'proof'
  | 'first-run';

export const STANDALONE_SURFACES: readonly SurfaceId[] = ['proof', 'first-run'];

/**
 * Everything `actionsEl` reads. It is deliberately narrower than `ActionView`: what a button
 * needs is a label, an id and whether it leads, and nothing about what the action *does*. The
 * app's `ActionView` carries a `dispatch` and a gesture card's action carries an `intent`;
 * both satisfy this, which is what lets one renderer serve both surfaces instead of two
 * copies drifting apart on the ordering law below.
 */
export interface RenderableAction {
  readonly id: string;
  readonly label: string;
  readonly primary: boolean;
}

/**
 * Buttons for a list of actions, primary first — action before description, everywhere.
 *
 * `describedBy` is the id of the text those actions act on, and it is not optional in
 * practice. The ordering law puts the button before the promise, which is right for a
 * sighted reader scanning a column and wrong for anyone who hears the page: a brief with
 * five cards announces "Mark done, button" five times with nothing to tell them apart. The
 * association restores what the visual layout conveys by proximity.
 */
export function actionsEl(actions: readonly RenderableAction[], describedBy?: string): El {
  return el(
    'div',
    { class: 'card-actions' },
    actions.map((action) =>
      textEl('button', action.label, {
        type: 'button',
        class: action.primary ? 'action action-primary' : 'action',
        'data-action': action.id,
        ...(describedBy === undefined ? {} : { 'aria-describedby': describedBy }),
      }),
    ),
  );
}

/** The id of a card's own words — what its buttons point at, and what names the card. */
function whatId(cardId: string): string {
  return `what-${cardId}`;
}

function actionsOf(card: CardView): El {
  return actionsEl(card.actions, whatId(card.id));
}

/**
 * A name and the evidence behind it, as one node. M-12 has no branch anywhere in this file
 * that emits the first without the second — every surface that shows a name calls this.
 */
function partyPairEl(party: PartyView): El {
  return el('span', { class: 'party-pair' }, [
    // `bdi`, not `span`: the name and its level are inline siblings and therefore one bidi
    // paragraph, so an unterminated U+202E inside a name reorders the level beside it. The
    // name is content and is shown as recorded — the defence is containment, not censorship.
    textEl('bdi', party.display, { class: party.isKey ? 'party party-key' : 'party' }),
    textEl('span', party.trust.label, {
      class: `trust relief-${party.trust.relief}`,
      'data-level': party.trust.level,
    }),
  ]);
}

/**
 * The mark, and how much relief it is struck in.
 *
 * Two axes, deliberately: the SHAPE is the promise's state (§4), the RELIEF is the evidence
 * behind the name (M-12). They are independent — a confirmed promise with an unverified
 * counterparty is a joined seal struck flat — so both classes land on the same element and
 * neither can be read off the other.
 *
 * The relief was for a long time emitted on the trust *text* instead, where the stylesheet's
 * `.seal.relief-*` rules could never match it. Every level therefore rendered as the same
 * 1px circle, and the M-12 test still passed: it asserted the class name appeared in the
 * HTML, and a substring cannot tell which element carries it.
 */
function sealEl(shape: string, label: string, relief?: string): El {
  const relieved = relief === undefined ? '' : ` relief-${relief}`;
  return el('span', { class: `seal seal-${shape}${relieved}`, role: 'img', 'aria-label': label });
}

/**
 * M-12 in one place: the seal's relief and the words for the evidence level are emitted
 * together with the name, from the same values, in the same paragraph. There is no branch
 * that renders a name and omits what stands behind it.
 */
function withWhomOf(card: CardView): El {
  if (card.withWhom === null) {
    // Not a name, so there is no evidence level to display beside it (M-12 is about names),
    // and no relief to strike the seal in.
    return el('p', { class: 'with' }, [
      sealEl(card.seal.shape, card.seal.label),
      textEl('span', COPY.party.justYou, { class: 'party party-self' }),
    ]);
  }
  return el('p', { class: 'with' }, [
    sealEl(card.seal.shape, card.seal.label, card.withWhom.trust.relief),
    partyPairEl(card.withWhom),
  ]);
}

export function cardEl(card: CardView): El {
  return el(
    'li',
    { class: 'card', 'data-card': card.id, 'aria-labelledby': whatId(card.id) },
    [
      actionsOf(card),
      textEl('p', card.what, { class: 'what', id: whatId(card.id) }),
      withWhomOf(card),
      textEl('p', card.ifIDoNothing, { class: `consequence tone-${card.tone}` }),
    ],
  );
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
    { id: 'team', label: COPY.nav.team },
    { id: 'trust', label: COPY.nav.trust },
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
    // What the brief ranked and this view could not fetch. Below the cards, because it is not
    // one of them — and present, because its absence is what made an incomplete brief look
    // like a complete one.
    ...(brief.unresolvedLine === null
      ? []
      : [textEl('p', brief.unresolvedLine, { class: 'below-the-line' })]),
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

/**
 * The team surface. A list of what has been shared and what it holds up — and structurally
 * incapable of being anything else, because `TeamView` carries nothing per person to render
 * (M-11). Note what has no element here: no counts, no ordering control, no column that
 * could be read down as a comparison between two people.
 */
export function teamEl(team: TeamView): El {
  return el('section', { 'aria-labelledby': 'team-heading', class: 'surface' }, [
    textEl('h1', team.heading, { id: 'team-heading' }),
    textEl('p', team.lede, { class: 'generated' }),
    ...(team.entries.length === 0
      ? [textEl('p', team.empty, { class: 'empty' })]
      : [el('ul', { class: 'cards' }, team.entries.map(teamEntryEl))]),
    textEl('p', team.note, { class: 'below-the-line' }),
  ]);
}

function teamEntryEl(entry: TeamEntryView): El {
  return el('li', { class: 'card', 'data-card': entry.id }, [
    textEl('p', entry.what, { class: 'what' }),
    el('p', { class: 'with' }, [
      sealEl(entry.seal.shape, entry.seal.label),
      ...entry.between.map(partyPairEl),
    ]),
    textEl('p', entry.ifNothingHappens, { class: `consequence tone-${entry.tone}` }),
    textEl('p', entry.blocksLine, { class: 'blocks' }),
  ]);
}

/**
 * The proof page. It is read by strangers, so it explains itself; it is a certificate, so
 * the hashes are shown in full and set in mono rather than tucked away.
 *
 * The words of the promise appear in exactly one element, and only when `view.words` is a
 * string — which `buildProof` produces only when both parties agreed and the plaintext
 * still exists. Every other element on this page renders from hashes, keys and dates.
 */
export function proofEl(view: ProofView): El {
  return el('section', { 'aria-labelledby': 'proof-heading', class: 'surface proof' }, [
    textEl('h1', view.heading, { id: 'proof-heading' }),
    textEl('p', view.lede, { class: 'generated' }),
    textEl('p', view.outcome, { class: 'outcome' }),

    textEl('h2', view.betweenHeading, { id: 'proof-between' }),
    el(
      'ul',
      { class: 'parties' },
      view.parties.map((p) =>
        el('li', { class: 'party-row' }, [
          textEl('span', p.role, { class: 'party-role' }),
          partyPairEl(p.party),
          textEl('span', p.key, { class: 'hash' }),
        ]),
      ),
    ),

    textEl('h2', view.datesHeading, { id: 'proof-dates' }),
    el(
      'ul',
      { class: 'dates' },
      view.dates.map((d) =>
        el('li', { class: 'date-row' }, [
          textEl('span', d.label, { class: 'date-label' }),
          textEl('span', d.value, { class: 'hash' }),
        ]),
      ),
    ),

    textEl('h2', view.chainHeading, { id: 'proof-chain' }),
    el(
      'ol',
      { class: 'chain' },
      view.chain.map((step) =>
        el('li', { class: 'chain-step' }, [
          sealEl(step.seal.shape, step.seal.label),
          textEl('span', step.label, { class: 'chain-label' }),
          textEl('span', step.when, { class: 'hash' }),
          textEl('span', step.signedBy, { class: 'hash' }),
          ...(step.evidence === null ? [] : [textEl('span', COPY.proof.evidence, { class: 'chain-evidence' })]),
        ]),
      ),
    ),

    textEl('h2', view.fingerprintHeading, { id: 'proof-fingerprint' }),
    textEl('p', view.fingerprint, { class: 'hash fingerprint' }),
    textEl('p', view.fingerprintNote, { class: 'below-the-line' }),

    textEl('h2', view.wordsHeading, { id: 'proof-words' }),
    ...(view.words === null ? [] : [textEl('p', view.words, { class: 'what' })]),
    textEl('p', view.wordsNote, { class: 'below-the-line' }),
    ...(view.actions.length === 0 ? [] : [actionsEl(view.actions)]),
  ]);
}

/**
 * First run. Three steps as an ordered list, because it is one, and the recovery sheet as
 * its own region with both of its controls present — the one that prints it and the one
 * that walks past it.
 */
export function onboardingEl(view: OnboardingView): El {
  return el('section', { 'aria-labelledby': 'first-run-heading', class: 'surface' }, [
    textEl('h1', view.heading, { id: 'first-run-heading' }),
    textEl('p', view.lede, { class: 'generated' }),
    el(
      'ol',
      { class: 'steps' },
      view.steps.map((step) =>
        el(
          'li',
          { class: step.current ? 'step step-current' : step.done ? 'step step-done' : 'step' },
          [
            ...(step.action === null ? [] : [actionsEl([step.action])]),
            textEl('h2', step.heading),
            textEl('p', step.blurb, { class: 'consequence' }),
          ],
        ),
      ),
    ),
    textEl('p', view.custody, { class: 'below-the-line' }),
    el('section', { 'aria-labelledby': 'recovery-heading', class: 'recovery' }, [
      textEl('h2', view.recovery.heading, { id: 'recovery-heading' }),
      actionsEl(view.recovery.actions),
      textEl('p', view.recovery.blurb, { class: 'consequence' }),
      textEl('p', view.recovery.wordsHeading, { class: 'date-label' }),
      el(
        'ol',
        { class: 'recovery-words' },
        view.recovery.words.map((word) => textEl('li', word, { class: 'hash' })),
      ),
      textEl('p', view.recovery.later, { class: 'below-the-line' }),
    ]),
  ]);
}

/**
 * Integrations & Trust. Sources carry a control; rungs never do — there is no `button`, no
 * `data-action` and no focusable element anywhere inside a gradient, because a control that
 * moved a rung would be a control that grants leeway, and leeway is earned.
 */
export function integrationsEl(view: IntegrationsView): El {
  return el('section', { 'aria-labelledby': 'trust-heading', class: 'surface' }, [
    textEl('h1', view.heading, { id: 'trust-heading' }),
    textEl('h2', view.sourcesHeading, { id: 'sources-heading' }),
    el(
      'ul',
      { class: 'cards' },
      view.sources.map((source) =>
        el('li', { class: 'card', 'data-card': source.id }, [
          actionsEl([source.action]),
          textEl('p', source.label, { class: 'what' }),
          textEl('p', source.status, { class: 'consequence' }),
          textEl('p', source.lastRead, { class: 'below-the-line' }),
        ]),
      ),
    ),
    textEl('h2', view.trustHeading, { id: 'trust-gradient-heading' }),
    textEl('p', view.trustLede, { class: 'generated' }),
    el('ul', { class: 'classes' }, view.classes.map(workClassEl)),
  ]);
}

function workClassEl(workClass: WorkClassView): El {
  return el('li', { class: 'work-class' }, [
    textEl('h3', workClass.label),
    el(
      'ul',
      { class: 'rungs' },
      workClass.rungs.map((rung) =>
        el('li', { class: `rung rung-${rung.state}` }, [
          textEl('span', rung.label, { class: 'rung-label' }),
          textEl('span', rung.stateLabel, { class: 'rung-state' }),
          ...(rung.explains === null ? [] : [textEl('span', rung.explains, { class: 'rung-explains' })]),
        ]),
      ),
    ),
  ]);
}

export interface AppView {
  readonly surface: SurfaceId;
  readonly brief: BriefView;
  readonly ledger: LedgerView;
  readonly inbox: InboxView;
  readonly team: TeamView;
  readonly integrations: IntegrationsView;
  readonly onboarding: OnboardingView;
  /** Null on every surface but the proof page, which needs a specific promise to exist. */
  readonly proof: ProofView | null;
}

function bodyEl(app: AppView): El {
  switch (app.surface) {
    case 'brief':
      return briefEl(app.brief);
    case 'inbox':
      return inboxEl(app.inbox);
    case 'team':
      return teamEl(app.team);
    case 'trust':
      return integrationsEl(app.integrations);
    case 'first-run':
      return onboardingEl(app.onboarding);
    case 'proof':
      // A proof page with no promise behind it would be a heading over nothing.
      return app.proof === null ? el('section', { class: 'surface' }) : proofEl(app.proof);
    default:
      return ledgerEl(app.ledger, app.surface);
  }
}

/** The whole surface: navigation plus whichever view is showing. */
export function appEl(app: AppView): El {
  const body = bodyEl(app);
  const children = STANDALONE_SURFACES.includes(app.surface) ? [body] : [navEl(app.surface), body];
  return el('main', { id: 'servanda', class: 'servanda' }, children);
}

/**
 * The proof page as a whole document, which is what "a shareable certificate at a public
 * URL" means. Self-contained: the stylesheet is inlined for the same reason the email's is,
 * and nothing here fetches anything.
 */
export function proofDocument(view: ProofView, css: string = THEME_CSS): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(view.heading)}</title>`,
    `<style>${css}</style>`,
    '</head><body>',
    `<main id="servanda" class="servanda">${renderToHtml(proofEl(view))}</main>`,
    '</body></html>',
  ].join('');
}
