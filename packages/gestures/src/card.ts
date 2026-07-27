import type { El, PartyView, SealView } from '@servanda/client-web';
// `actionsEl` comes from the app renderer rather than being restated here: the ordering law
// it encodes — primary first, so Tab and a screen reader both reach the leading action first —
// must be the same law on a gesture card as on an app card, and one implementation is the only
// way to say that once.
import { COPY, actionsEl, el, partyFor, sealFor, textEl } from '@servanda/client-web';
import type { PlaceId } from './copy.js';
import { GESTURE_COPY } from './copy.js';
import type { CommitIntent, ConfirmIntent, ExpectIntent, GestureIntent } from './intent.js';
import { commitIntent, confirmIntent, dismissIntent, expectIntent } from './intent.js';
import type { Quoted } from './quote.js';
import type { OwnUtterance, Utterance, UtteranceRef } from './utterance.js';

/**
 * The card.
 *
 * Capture and confirmation have no screens of their own by definition, so this is the whole
 * surface: one typed object, renderable wherever the promise was spoken, answering the three
 * questions every card in this product answers — **what · with whom · what happens if I do
 * nothing** — with the primary action leading it.
 *
 * Three kinds, and which one you get is decided entirely by two facts that are not the
 * card's to choose: whose words these are, and whether anything is already pending on them.
 *
 *  - `confirm-own-promise` — your words, an extraction already waiting. One tap confirms,
 *    one dismisses, and **both are labels** (ADR-0012). The dismissal is the more valuable
 *    of the two and is carried as data rather than discarded as a non-event.
 *  - `record-own-promise` — your words, nothing pending. The gesture *is* the confirmation;
 *    there is nothing yet to accept or throw away, so the card offers one action and says
 *    so. This is capture level 0 (ux doc) and the honest shape for it.
 *  - `note-expectation` — somebody else's words. It cannot become their promise (M-1). It
 *    becomes a note that you are waiting, held by you, which never leaves your machine.
 *
 * `interrupts` is typed `false` everywhere and has no other inhabitant. Zero interrupts is
 * an interaction law, and a law is better expressed as a type with one value than as a
 * setting somebody can flip.
 */

export type DeliveryMoment = 'in-situ' | 'batched';

export interface Delivery {
  /** Where the card is shown: under the words, or in the next brief with everything else. */
  readonly moment: DeliveryMoment;
  /** Always false. A gesture is never an interruption; see `whenTheOtherHalfArrives`. */
  readonly interrupts: false;
}

export interface GestureAction<I extends GestureIntent = GestureIntent> {
  readonly id: string;
  readonly label: string;
  readonly primary: boolean;
  readonly intent: I;
}

export interface GestureCardBase {
  readonly id: string;
  readonly place: PlaceId;
  /** Back to the words. A reference, never a fetch — nothing here goes to a network. */
  readonly ref: UtteranceRef;
  readonly heading: string;
  /** Where this came from, in the interface's voice. Never the payload's words. */
  readonly provenance: string;
  /** WHAT. Their words, quoted, passed through untouched (M-6). */
  readonly what: Quoted;
  /** WITH WHOM. Null when the promise is to yourself and never leaves this machine. */
  readonly withWhom: PartyView | null;
  /** WHAT HAPPENS IF I DO NOTHING. */
  readonly ifIDoNothing: string;
  readonly seal: SealView;
  readonly delivery: Delivery;
}

export interface ConfirmCard extends GestureCardBase {
  readonly kind: 'confirm-own-promise';
  /** Confirm leads; dismiss follows. Both are §7 `confirm`, both are labels. */
  readonly actions: readonly [GestureAction<ConfirmIntent>, GestureAction<ConfirmIntent>];
}

export interface RecordCard extends GestureCardBase {
  readonly kind: 'record-own-promise';
  readonly actions: readonly [GestureAction<CommitIntent>];
}

export interface ExpectationCard extends GestureCardBase {
  readonly kind: 'note-expectation';
  /** Noting leads. A dismissal follows only when there is a queue item to dismiss. */
  readonly actions: readonly [GestureAction<ExpectIntent>, ...GestureAction<ConfirmIntent>[]];
}

export type GestureCard = ConfirmCard | RecordCard | ExpectationCard;

export const IN_SITU: Delivery = { moment: 'in-situ', interrupts: false };

/**
 * The same card, at a different moment. A meeting-end card is not a second kind of object:
 * it is this one, built from a transcript line instead of a message, and delivered when the
 * meeting ends instead of when somebody reacts.
 */
export const AT_MEETING_END: Delivery = { moment: 'batched', interrupts: false };

/** A name and the evidence behind it, or nothing. M-12 has no branch that emits one alone. */
function partyOf(speaker: { display: Quoted; verification: PartyView['trust']['level'] } | null): PartyView | null {
  if (speaker === null) return null;
  return partyFor(speaker.display, speaker.verification);
}

/**
 * Your own words, with an extraction already waiting on them: the central case, and the one
 * scenario 4 is about. Takes `OwnUtterance`, so a promise somebody else made cannot reach
 * this function at all (M-1).
 */
export function confirmCard(
  utterance: OwnUtterance,
  pendingId: string,
  delivery: Delivery = IN_SITU,
): ConfirmCard {
  return {
    kind: 'confirm-own-promise',
    id: pendingId,
    place: utterance.place,
    ref: utterance.ref,
    heading: GESTURE_COPY.confirm.heading,
    provenance: GESTURE_COPY.confirm.from(GESTURE_COPY.place[utterance.place]),
    what: utterance.text,
    withWhom: partyOf(utterance.owedTo),
    ifIDoNothing: GESTURE_COPY.confirm.consequence,
    seal: sealFor('none'),
    delivery,
    actions: [
      {
        id: `${pendingId}:confirm`,
        label: COPY.actions.confirm,
        primary: true,
        intent: confirmIntent(utterance, pendingId),
      },
      {
        id: `${pendingId}:dismiss`,
        label: COPY.actions.dismiss,
        primary: false,
        intent: dismissIntent(utterance, pendingId),
      },
    ],
  };
}

/** Your own words, nothing pending. The gesture is the whole of it. */
export function recordCard(utterance: OwnUtterance, id: string): RecordCard {
  return {
    kind: 'record-own-promise',
    id,
    place: utterance.place,
    ref: utterance.ref,
    heading: GESTURE_COPY.record.heading,
    provenance: GESTURE_COPY.confirm.from(GESTURE_COPY.place[utterance.place]),
    what: utterance.text,
    withWhom: partyOf(utterance.owedTo),
    ifIDoNothing: GESTURE_COPY.record.consequence,
    seal: sealFor('none'),
    delivery: IN_SITU,
    actions: [
      {
        id: `${id}:record`,
        label: GESTURE_COPY.record.action,
        primary: true,
        intent: commitIntent(utterance),
      },
    ],
  };
}

/**
 * Somebody else's words. There is no argument to this function by which their promise could
 * be recorded as theirs, because there is no such intent in the card's type.
 */
export function expectationCard(
  utterance: Utterance,
  id: string,
  delivery: Delivery = IN_SITU,
): ExpectationCard {
  const dismissals: GestureAction<ConfirmIntent>[] =
    utterance.pendingId === null
      ? []
      : [
          {
            id: `${id}:dismiss`,
            label: COPY.actions.dismiss,
            primary: false,
            intent: dismissIntent(utterance, utterance.pendingId),
          },
        ];
  return {
    kind: 'note-expectation',
    id,
    place: utterance.place,
    ref: utterance.ref,
    heading: GESTURE_COPY.expectation.heading,
    provenance: GESTURE_COPY.expectation.from(
      utterance.speaker.display,
      GESTURE_COPY.theirPlace[utterance.place],
    ),
    what: utterance.text,
    withWhom: partyOf(utterance.speaker),
    ifIDoNothing: GESTURE_COPY.expectation.consequence,
    seal: sealFor('none'),
    delivery,
    actions: [
      {
        id: `${id}:expect`,
        label: GESTURE_COPY.expectation.action,
        primary: true,
        intent: expectIntent(utterance),
      },
      ...dismissals,
    ],
  };
}

/** The three questions, as data, so that "every card answers them" is checkable. */
export interface ThreeQuestions {
  readonly what: string;
  readonly withWhom: string;
  readonly ifIDoNothing: string;
}

export function threeQuestions(card: GestureCard): ThreeQuestions {
  return {
    what: card.what,
    withWhom: card.withWhom === null ? COPY.party.justYou : card.withWhom.display,
    ifIDoNothing: card.ifIDoNothing,
  };
}

export function primaryAction(card: GestureCard): GestureAction {
  return card.actions[0];
}

/**
 * The two-taps problem, answered where it is actually answerable.
 *
 * Scenario 4 exposed it: confirm-first costs two taps from two people for one sentence in a
 * review comment. This card does not make the second tap disappear — nothing can, because
 * the second signature is what makes the promise bilateral (M-2). What it does is make the
 * two taps neither blocking nor simultaneous:
 *
 *  - The promiser's tap happens where they already are, in the same window, and records
 *    their own half at once. You owe what you owe, network or not.
 *  - The other party is never gestured at. Their half arrives batched in their next brief,
 *    with everything else, and interrupts nothing.
 *
 * Two interrupting taps become one in-place tap and one batched line. This function is the
 * statement of that, in the type system: the counterparty's delivery is `batched`, and there
 * is no value of `interrupts` other than false.
 */
export function whenTheOtherHalfArrives(): Delivery {
  return { moment: 'batched', interrupts: false };
}

// ── rendering ─────────────────────────────────────────────────────────────────────────────

/** M-12: the name and what stands behind it are emitted together, from the same values. */
function withWhomEl(card: GestureCard): El {
  // Shape is the promise's state; relief is the evidence behind the name (M-12). Both land on
  // the seal, because the stylesheet's `.seal.relief-*` rules match nowhere else — relief put
  // on the trust text renders every level as the same flat circle.
  const sealClass = (relief?: string): string =>
    `seal seal-${card.seal.shape}${relief === undefined ? '' : ` relief-${relief}`}`;

  if (card.withWhom === null) {
    return el('p', { class: 'with' }, [
      el('span', { class: sealClass(), role: 'img', 'aria-label': card.seal.label }),
      textEl('span', COPY.party.justYou, { class: 'party party-self' }),
    ]);
  }
  return el('p', { class: 'with' }, [
    el('span', {
      class: sealClass(card.withWhom.trust.relief),
      role: 'img',
      'aria-label': card.seal.label,
    }),
    el('span', { class: 'party-pair' }, [
      textEl('span', card.withWhom.display, {
        class: card.withWhom.isKey ? 'party party-key' : 'party',
      }),
      textEl('span', card.withWhom.trust.label, {
        class: `trust relief-${card.withWhom.trust.relief}`,
        'data-level': card.withWhom.trust.level,
      }),
    ]),
  ]);
}

/**
 * The card as an element tree. Text nodes are escaped on render, which is where the second
 * half of M-6 lives: quoted words are shown, and shown is all they ever are.
 */
export function gestureCardEl(card: GestureCard): El {
  // The buttons are announced before the words they act on, so they have to say which words
  // those are. A gesture card carries one promise, but it is delivered beside other cards in a
  // batched brief, where "Confirm, button" on its own names nothing.
  const whatId = `gesture-what-${card.id}`;
  return el(
    'article',
    { class: `gesture-card gesture-${card.kind}`, 'data-card': card.id, 'data-place': card.place },
    [
      textEl('h2', card.heading, { class: 'gesture-heading' }),
      actionsEl(card.actions, whatId),
      textEl('blockquote', card.what, { class: 'what quoted', id: whatId }),
      withWhomEl(card),
      textEl('p', card.ifIDoNothing, { class: 'consequence' }),
      textEl('p', card.provenance, { class: 'provenance' }),
    ],
  );
}
