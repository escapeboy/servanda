import type {
  BriefOutput,
  NodeToolName,
  OpenLoopAction,
  OpenLoopItem,
  OpenLoopsOutput,
  VerificationLevel,
} from '@servanda/types';
import { COPY } from './copy.js';
import type { SealView, TrustView } from './seal.js';
import { sealFor, trustFor } from './seal.js';

/**
 * The one renderer contract.
 *
 * Everything a person can be shown is computed once, here, from §7 tool output. The web
 * surface, the terminal and the morning email are three renderings of these structures and
 * share every word and every ordering decision — "identical content; one renderer contract"
 * is a property of the code, not a promise in a document.
 *
 * Nothing in this module reads a clock. `now` is passed in, so the same node state renders
 * the same way in a test, in a terminal and in an email sent by a scheduler.
 */

export interface PartyView {
  /** What is shown. Shortened when the counterparty is a key rather than a name. */
  readonly display: string;
  /** Whether `display` is a key. Keys are set in mono and never dressed up as names. */
  readonly isKey: boolean;
  /** M-12: a name never travels without the evidence that stands behind it. */
  readonly trust: TrustView;
}

export type ActionDispatch =
  | { readonly kind: 'tool'; readonly tool: NodeToolName; readonly args: Record<string, unknown> }
  | { readonly kind: 'needs-input'; readonly tool: NodeToolName; readonly needs: 'date' }
  | { readonly kind: 'unmapped'; readonly action: OpenLoopAction }
  /**
   * One party agreeing, for themselves alone, that the words of a promise may be shown on
   * its proof page. Deliberately not a tool call and deliberately not a setting: it is a
   * consent, it is recorded per party, and one party's consent shows nothing on its own.
   */
  | { readonly kind: 'consent'; readonly consent: 'show-words'; readonly by: 'owner' | 'owed-to' }
  /** Connecting or disconnecting a source. Never a control that grants leeway (doctrine). */
  | { readonly kind: 'source'; readonly source: string; readonly op: 'connect' | 'disconnect' }
  /** The first-run path, which has no register behind it yet. */
  | { readonly kind: 'first-run'; readonly step: string };

export interface ActionView {
  readonly id: string;
  readonly label: string;
  readonly primary: boolean;
  readonly dispatch: ActionDispatch;
}

/**
 * The only place colour carries meaning. Three tones, none of them a verdict: a date that
 * has passed is amber because it is a fact worth seeing, not because someone was bad.
 */
export type ConsequenceTone = 'plain' | 'passed' | 'settled';

export interface CardView {
  readonly id: string;
  /** What. The person's own words, passed through untouched. */
  readonly what: string;
  /** With whom. Null when the promise is to yourself and never leaves this machine. */
  readonly withWhom: PartyView | null;
  /** What happens if I do nothing. */
  readonly ifIDoNothing: string;
  readonly tone: ConsequenceTone;
  readonly seal: SealView;
  /** Action before description: the primary is first and leads the card. */
  readonly actions: readonly ActionView[];
}

export interface SectionView {
  readonly id: 'owe' | 'waiting' | 'closed';
  readonly heading: string;
  readonly empty: string;
  readonly cards: readonly CardView[];
}

export interface BriefView {
  readonly heading: string;
  readonly generatedAt: string;
  readonly generatedLine: string;
  readonly empty: string;
  readonly cards: readonly CardView[];
  readonly belowTheLine: string | null;
  /** For the email subject line, which needs counts before it has cards. */
  readonly counts: { readonly owe: number; readonly waiting: number };
}

export interface LedgerView {
  readonly sections: readonly SectionView[];
}

export interface InboxView {
  readonly heading: string;
  readonly empty: string;
  readonly consequence: string;
  readonly cards: readonly CardView[];
}

const KEY_SHAPE = /^[0-9a-f]{64}$/u;
const DAY_MS = 86_400_000;

/** Whole days between two instants, floored towards the past. */
function daysBetween(fromIso: string, toIso: string): number {
  return Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS);
}

/** A raw 64-character key is not a name and is never shown as one. */
export function shortKey(key: string): string {
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function isKeyShaped(value: string): boolean {
  return KEY_SHAPE.test(value);
}

export function partyFor(counterparty: string | null, level: VerificationLevel): PartyView | null {
  if (counterparty === null || counterparty.trim().length === 0) return null;
  const isKey = isKeyShaped(counterparty);
  return {
    display: isKey ? shortKey(counterparty) : counterparty,
    isKey,
    trust: trustFor(level),
  };
}

/**
 * The third question, answered as a fact about a date rather than a verdict about a person.
 * `waiting` flips the subject: the days belong to them, not to you.
 */
export function consequenceFor(
  item: OpenLoopItem,
  now: string,
  waiting: boolean,
): { text: string; tone: ConsequenceTone } {
  if (item.state === 'closed' || item.state === 'released' || item.state === 'expired') {
    return { text: COPY.consequence.settled, tone: 'settled' };
  }
  if (item.due === null) {
    const days = Math.max(0, Math.floor(item.age_days));
    return {
      text: waiting ? COPY.consequence.waitingNoDate(days) : COPY.consequence.openNoDate(days),
      tone: 'plain',
    };
  }
  const delta = daysBetween(now, item.due);
  if (delta === 0) {
    return { text: waiting ? COPY.consequence.theirsToday : COPY.consequence.dueToday, tone: 'plain' };
  }
  if (delta === 1) {
    return {
      text: waiting ? COPY.consequence.theirsTomorrow : COPY.consequence.dueTomorrow,
      tone: 'plain',
    };
  }
  if (delta > 1) {
    return {
      text: waiting ? COPY.consequence.theirsInDays(delta) : COPY.consequence.dueInDays(delta),
      tone: 'plain',
    };
  }
  const passed = Math.abs(delta);
  const text = waiting
    ? passed === 0
      ? COPY.consequence.theirsPassedToday
      : COPY.consequence.theirsPassedDays(passed)
    : passed === 0
      ? COPY.consequence.passedToday
      : COPY.consequence.passedDays(passed);
  return { text, tone: 'passed' };
}

/**
 * §7 offers five item actions but names tools for only some of them. `confirm` covers
 * accept, dismiss and revise-the-date; `done`, `release`, `delegate` and `ping` have no §7
 * tool at all — §7 says additional tools MAY be exposed, and these evidently need them.
 *
 * SPEC GAP (narrowest reading): rather than invent tool names, the client emits a typed,
 * unmapped intent for those four and leaves the binding to whoever wires the surface up.
 * Reported in the stream report.
 */
export function dispatchFor(action: OpenLoopAction): ActionDispatch {
  if (action === 'supersede') return { kind: 'needs-input', tool: 'confirm', needs: 'date' };
  return { kind: 'unmapped', action };
}

function actionsFor(item: OpenLoopItem): ActionView[] {
  return item.actions.map((action, index) => ({
    id: `${item.id}:${action}`,
    label: COPY.actions[action],
    primary: index === 0,
    dispatch: dispatchFor(action),
  }));
}

export function cardFor(item: OpenLoopItem, now: string, waiting: boolean): CardView {
  const consequence = consequenceFor(item, now, waiting);
  return {
    id: item.id,
    what: item.intent_or_expect,
    withWhom: partyFor(item.counterparty, item.verification_level),
    ifIDoNothing: consequence.text,
    tone: consequence.tone,
    seal: sealFor(item.state),
    actions: actionsFor(item),
  };
}

/** Which side of the register an item sits on, from the shape of the item itself. */
export function isWaiting(item: OpenLoopItem): boolean {
  return item.kind === 'expectation';
}

const CLOSED_STATES = new Set(['closed', 'released', 'expired', 'superseded']);

export function buildLedger(loops: OpenLoopsOutput, now: string): LedgerView {
  const owe: CardView[] = [];
  const waiting: CardView[] = [];
  const closed: CardView[] = [];
  // Order is the node's: the attention market decides, never a sort control (doctrine).
  for (const item of loops.items) {
    const wait = isWaiting(item);
    const card = cardFor(item, now, wait);
    if (CLOSED_STATES.has(item.state)) closed.push(card);
    else if (wait) waiting.push(card);
    else owe.push(card);
  }
  return {
    sections: [
      { id: 'owe', heading: COPY.sections.owe, empty: COPY.empty.owe, cards: owe },
      { id: 'waiting', heading: COPY.sections.waiting, empty: COPY.empty.waiting, cards: waiting },
      { id: 'closed', heading: COPY.sections.closed, empty: COPY.empty.closed, cards: closed },
    ],
  };
}

/**
 * The Brief. §7 gives each slot a headline and the action that should lead the card; the
 * substance comes from the matching open item, so that a brief card answers the same three
 * questions every other card answers.
 *
 * The node also supplies `primary_action.label`. It is not rendered: the voice of the
 * interface is the interface's responsibility, and a label arriving over a connection is
 * exactly where the register would slip. Which action leads is honoured; what it is called
 * is not.
 */
export function buildBrief(brief: BriefOutput, loops: OpenLoopsOutput, now: string): BriefView {
  const byId = new Map(loops.items.map((item) => [item.id, item]));
  const cards: CardView[] = [];
  let owe = 0;
  let waiting = 0;

  for (const slot of brief.slots) {
    const item = byId.get(slot.item_id);
    if (item === undefined) {
      // A slot with no matching item cannot answer all three questions; showing a headline
      // with nothing behind it would be worse than leaving it out.
      continue;
    }
    const wait = isWaiting(item);
    if (wait) waiting++;
    else owe++;
    const card = cardFor(item, now, wait);
    const led = leadWith(card, slot.primary_action.tool);
    cards.push({ ...card, what: slot.headline, actions: led });
  }

  return {
    heading: COPY.brief.heading,
    generatedAt: brief.generated_at,
    generatedLine: COPY.brief.generated(brief.generated_at),
    empty: COPY.brief.empty,
    cards,
    belowTheLine:
      brief.below_the_line_count > 0 ? COPY.brief.belowTheLine(brief.below_the_line_count) : null,
    counts: { owe, waiting },
  };
}

/** Honour the node's choice of leading action without adopting its wording. */
function leadWith(card: CardView, tool: string): readonly ActionView[] {
  const index = card.actions.findIndex(
    (a) =>
      (a.dispatch.kind === 'tool' || a.dispatch.kind === 'needs-input') && a.dispatch.tool === tool,
  );
  if (index <= 0) return card.actions;
  const led = card.actions[index];
  if (led === undefined) return card.actions;
  const rest = card.actions.filter((_, i) => i !== index);
  return [{ ...led, primary: true }, ...rest.map((a) => ({ ...a, primary: false }))];
}

/**
 * The confirmation inbox. §7's `confirm` serves both inbound proposals and the local
 * extraction queue, so both arrive here with the same two answers.
 */
export function buildInbox(pending: OpenLoopsOutput, now: string): InboxView {
  return {
    heading: COPY.inbox.heading,
    empty: COPY.inbox.empty,
    consequence: COPY.inbox.consequence,
    cards: pending.items.map((item) => ({
      ...cardFor(item, now, isWaiting(item)),
      ifIDoNothing: COPY.inbox.consequence,
      tone: 'plain' as const,
      actions: [
        {
          id: `${item.id}:confirm`,
          label: COPY.actions.confirm,
          primary: true,
          dispatch: {
            kind: 'tool' as const,
            tool: 'confirm' as const,
            args: { id: item.id, decision: 'confirm' },
          },
        },
        {
          id: `${item.id}:dismiss`,
          label: COPY.actions.dismiss,
          primary: false,
          dispatch: {
            kind: 'tool' as const,
            tool: 'confirm' as const,
            args: { id: item.id, decision: 'dismiss' },
          },
        },
      ],
    })),
  };
}
