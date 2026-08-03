import type {
  BriefOutput,
  NodeToolName,
  ItemAction,
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
  | { readonly kind: 'unmapped'; readonly action: ItemAction['act'] }
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
  /**
   * Slots the brief ranked that this view could not render, because `open_loops` did not return
   * the item behind them. With `persona: null` that is every slot of every non-active persona —
   * §7 lets `brief` rank across personas and does not let `open_loops` fetch across them. A
   * surface that shows nothing about them presents a partial ranking as the whole one.
   */
  readonly unresolved: number;
  /**
   * `unresolved` said as a sentence, or null when there is nothing to say. The count alone
   * was carried on this view model for a while and no renderer read it, so a brief with two
   * unreachable slots and no reachable ones still printed "Nothing is waiting on you today."
   */
  readonly unresolvedLine: string | null;
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

/** The UTC midnight that starts the day an instant falls in, or null if it cannot be read. */
function startOfDay(iso: string): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Whole days between two instants, counted the way a calendar counts them.
 *
 * This was elapsed milliseconds divided by a day and floored, which is a different quantity
 * and agrees with this one only when the two instants sit at the same time of day — which is
 * exactly how every fixture was written and is never how a morning is read. A promise that
 * came due at nine this morning was three quarters of a day old by evening, so the division
 * floored to −1 and the card said "The date passed yesterday" about today. In the other
 * direction the same arithmetic pulled tomorrow morning into "Due today" from lunchtime
 * onwards. Both are the interface stating a wrong fact on the one line a person reads first.
 *
 * UTC, because this module is forbidden to read a zone (see `readableInstant`) and the whole
 * surface already names its hours in UTC. Guessing the machine's zone here would make the
 * same register render differently on the laptop that shows it and the server that mails it.
 */
function daysBetween(fromIso: string, toIso: string): number {
  const from = startOfDay(fromIso);
  const to = startOfDay(toIso);
  if (from === null || to === null) return Number.NaN;
  return Math.round((to - from) / DAY_MS);
}

/** A raw 64-character key is not a name and is never shown as one. */
export function shortKey(key: string): string {
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function isKeyShaped(value: string): boolean {
  return KEY_SHAPE.test(value);
}

/**
 * §7 v0.2 (#39): the name arrives with its origin, and the two are rendered differently.
 *
 * An `attested` name is a claim the node makes about a third party, so M-12 binds it: it MUST NOT
 * appear above its evidence level. A `self-labelled` one is an `external_label` the viewer typed
 * for someone off-network — level 0 by construction, no claim about anyone, and the only name that
 * counterparty will ever have. Suppressing it would erase the person from their own register and
 * break the solo path M-10 protects.
 *
 * Until v0.1 gave clients no way to tell these apart, this function rendered every name at every
 * level, and M-12's client half was not merely untested — it was undecidable.
 */
export function partyFor(
  counterparty: OpenLoopItem['counterparty'],
  level: VerificationLevel,
): PartyView | null {
  if (counterparty === null || counterparty.value.trim().length === 0) return null;
  const { value, origin } = counterparty;
  const isKey = isKeyShaped(value);
  // A key is the wire identity, never a name, and is shown as one at any level: shortening it is
  // the client saying "this is a key", not dressing it up.
  if (origin === 'attested' && !isKey && !NAME_BEARING_LEVELS.includes(level)) {
    // The node sent a name its evidence does not support. Not `shortKey(value)` — that is for
    // KEYS, and applying it to a name produces a mangled name rather than an absent one, which is
    // worse than either honest answer. The client's own word stands there instead, so the card
    // still says who this is about and the seal still says how well it is evidenced.
    return { display: COPY.unevidencedParty, isKey: false, trust: trustFor(level) };
  }
  return {
    display: isKey ? shortKey(value) : value,
    isKey,
    trust: trustFor(level),
  };
}

/**
 * §1.6: only an attestation carries a name. `ext` outranks continuity and carries none — a binding
 * proof binds a key to a CHANNEL, never to a person — which is why this is not "level >= ext".
 */
const NAME_BEARING_LEVELS: readonly VerificationLevel[] = ['2', '3'];

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
  // The two states where a DATE says nothing true.
  //
  // Both are live, both are blocked on the other party, and neither is governed by `due` any
  // more — so falling through to the arithmetic below produced "Due tomorrow." for a promise its
  // owner had closed with evidence three days ago and that the counterparty had already released
  // them from. The tone is `passed` rather than `plain`: nothing is on fire, but something is
  // waiting on a person and a settled grey would say the opposite.
  if (item.state === 'contested-closure') {
    return { text: COPY.consequence.contested, tone: 'passed' };
  }
  if (item.state === 'disputed') {
    return { text: COPY.consequence.disputed, tone: 'passed' };
  }
  // A date this client cannot read is a date it can say nothing about. `due` is an RFC 3339
  // string at the §7 boundary, so a conforming node cannot send one — but the client is the
  // last stop, and the arithmetic below produced "The date passed NaN days ago" rather than
  // failing, which is the one outcome a person must never be shown.
  const delta = item.due === null ? Number.NaN : daysBetween(now, item.due);
  if (Number.isNaN(delta)) {
    const days = Math.max(0, Math.floor(item.age_days));
    return {
      text: waiting ? COPY.consequence.waitingNoDate(days) : COPY.consequence.openNoDate(days),
      tone: 'plain',
    };
  }
  if (delta === 0) {
    // The date is today's. Whether the hour has been and gone is the difference between a
    // thing still to do today and a thing that did not happen, and both readings exist here.
    // At the due instant exactly it is due, not missed: the hour has to be behind you.
    if (Date.parse(item.due as string) >= Date.parse(now)) {
      return { text: waiting ? COPY.consequence.theirsToday : COPY.consequence.dueToday, tone: 'plain' };
    }
    return {
      text: waiting ? COPY.consequence.theirsPassedToday : COPY.consequence.passedToday,
      tone: 'passed',
    };
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
  // Whole calendar days, so this is at least one: today's date is the branch above.
  const passed = Math.abs(delta);
  const text = waiting
    ? COPY.consequence.theirsPassedDays(passed)
    : COPY.consequence.passedDays(passed);
  return { text, tone: 'passed' };
}

/**
 * The node now says which tool signs an act and with what arguments (§7 `{act, tool, args}`),
 * so the client no longer guesses. `tool: null` means v0 binds the act to nothing — the client
 * may show it and MUST NOT invent a binding (M-20), which is what `unmapped` records.
 *
 * The gap this used to describe is closed: `done` and `release` reach the `act` tool now.
 */
export function dispatchFor(action: ItemAction): ActionDispatch {
  if (action.tool === null) return { kind: 'unmapped', action: action.act };
  if (action.act === 'supersede') return { kind: 'needs-input', tool: action.tool, needs: 'date' };
  return { kind: 'tool', tool: action.tool, args: action.args };
}

function actionsFor(item: OpenLoopItem): ActionView[] {
  return item.actions.map((action, index) => ({
    id: `${item.id}:${action.act}`,
    // M-21, the client half: the wording is ours. The node sent an act, never a label.
    label: COPY.actions[action.act],
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

/**
 * The three views §7 already defines, fetched as themselves.
 *
 * This replaces `isWaiting(item)`, which was `item.kind === 'expectation'` — and an edge is
 * `kind: 'edge'` for BOTH parties, so nothing in the ledger ever read the role. Ana promises
 * Boyan something and he confirms it; his screen then says **"You owe"**, with `Let it go`
 * (release — the act of the party who is OWED) sitting under that heading. `You are waiting` was
 * empty on both screens and structurally could hold only expectations, which by M-1 are exactly
 * the promises nobody has signed. The register's central distinction was inverted for one of the
 * two people it exists to serve.
 *
 * The node was never confused: `itemsFor` computes `isOwner` and buckets `view: 'owe'` and
 * `view: 'waiting'` correctly. The client asked for `view: 'all'` — which flattens the role away
 * — and then re-derived the answer with a rule that could not carry it. So the fix is not a new
 * member on the item; it is to stop asking a question whose answer is thrown away, and to take
 * the buckets from the surface that knows. The same doctrine as ordering: the node decides, the
 * client renders.
 */
export interface LedgerBuckets {
  readonly owe: OpenLoopsOutput;
  readonly waiting: OpenLoopsOutput;
  readonly closed: OpenLoopsOutput;
}

/** Ids the node placed in `view: 'waiting'` — the viewer is owed these, not obliged by them. */
export function waitingIdsOf(buckets: LedgerBuckets): ReadonlySet<string> {
  return new Set(buckets.waiting.items.map((i) => i.id));
}

export function buildLedger(buckets: LedgerBuckets, now: string): LedgerView {
  // Order is the node's: the attention market decides, never a sort control (doctrine).
  const owe = buckets.owe.items.map((item) => cardFor(item, now, false));
  const waiting = buckets.waiting.items.map((item) => cardFor(item, now, true));
  const closed = buckets.closed.items.map((item) =>
    // A closed item's `ifIDoNothing` is settled wording either way, but the role still decides
    // whose failing a date sentence describes, so it is not guessed here either.
    cardFor(item, now, item.kind === 'expectation'),
  );
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
export function buildBrief(
  brief: BriefOutput,
  loops: OpenLoopsOutput,
  now: string,
  /**
   * The ids the node put in `view: 'waiting'`. The brief's `counts` and each card's "if I do
   * nothing" both turn on the role, and this surface had the same inversion the ledger did — a
   * promise made TO you was counted as one you owe, and its consequence sentence named your
   * failing rather than theirs. Defaults to empty so a caller with no buckets gets "everything
   * is mine", which is the safe direction: it over-states what you owe rather than quietly
   * relieving you of it.
   */
  waitingIds: ReadonlySet<string> = new Set(),
): BriefView {
  const byId = new Map(loops.items.map((item) => [item.id, item]));
  const cards: CardView[] = [];
  let owe = 0;
  let waiting = 0;
  let unresolved = 0;

  for (const slot of brief.slots) {
    const item = byId.get(slot.item_id);
    if (item === undefined) {
      // A slot with no matching item cannot answer all three questions; showing a headline
      // with nothing behind it would be worse than leaving it out.
      //
      // This is NOT the rare case it reads as. §7's `brief` with `persona: null` ranks across
      // every persona — that is the one place cross-org ordering is allowed — while `open_loops`
      // with `persona: null` resolves to the ACTIVE persona alone, deliberately, because it
      // returns content and a second mixing point is what M-5 forbids. So every slot belonging to
      // any other persona lands here, on the ordinary path, and vanished without trace.
      // Counting them is not a UI decision; leaving the count at zero was the bug.
      unresolved++;
      continue;
    }
    const wait = waitingIds.has(item.id);
    if (wait) waiting++;
    else owe++;
    const card = cardFor(item, now, wait);
    // A slot whose primary action is null has nothing that signs — lead with whatever the card
    // already offers rather than promoting a control that does nothing.
    const led = slot.primary_action === null ? card.actions : leadWith(card, slot.primary_action.tool);
    // `slot.headline` is not read. §7 defines it as the commitment's intent "as they wrote
    // it", which is the item's own words — and the item is already in hand. A schema cannot
    // check that claim (`z.string()` takes copy as readily as content), and `<p class="what">`
    // is the card's accessible name, so a headline that diverged would be the node wording the
    // loudest thing on the surface. The brief decides what leads; `open_loops` says what it is.
    cards.push({ ...card, actions: led });
  }

  return {
    heading: COPY.brief.heading,
    generatedAt: brief.generated_at,
    generatedLine: COPY.brief.generated(brief.generated_at),
    empty: COPY.brief.empty,
    cards,
    belowTheLine:
      brief.below_the_line_count > 0 ? COPY.brief.belowTheLine(brief.below_the_line_count) : null,
    unresolved,
    unresolvedLine: unresolved > 0 ? COPY.brief.unresolved(unresolved) : null,
    counts: { owe, waiting },
  };
}

/** Honour the node's choice of leading action without adopting its wording. */
function leadWith(card: CardView, tool: string | null): readonly ActionView[] {
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
      // `false` and not a guess: every card here has its `ifIDoNothing` and `tone` replaced two
      // lines down with the inbox's own settled wording, so the role decides nothing on this
      // surface. A queue item is awaiting YOUR decision whichever side of it you are on.
      ...cardFor(item, now, false),
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
