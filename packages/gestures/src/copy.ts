import { COPY } from '@servanda/client-web';

/**
 * The gesture surface's words.
 *
 * There is one string table in this product and it lives in `@servanda/client-web`. This
 * file does not start a second one: every word that already exists there is *reused* here by
 * reference — the confirm and dismiss labels, the sentence that says nothing is recorded
 * until you confirm, "Just you", the whole verification vocabulary. What is added below is
 * only what a card shown inside somebody else's chat window needs and the app did not: where
 * the promise was spoken, and the one sentence that says why a promise somebody else made is
 * not yours to record.
 *
 * Gate GL scans this table and the rendered gesture cards under exactly the rules gate GE
 * applies to the app: zero forbidden vocabulary, zero exclamation marks. Notary, not coach.
 */

/**
 * Where a promise was spoken, as a closed set. Deliberately not a string from the payload:
 * the frame of the card is ours and only the quoted body is theirs (M-6).
 */
// `agent` is where §3 captures — the hook reads what you type at your own assistant — and it
// was missing while the other three were present. A closed set that omits the product's own
// headline capture path forces every card from it to claim it came from somewhere else.
export const PLACES = ['chat', 'pr-comment', 'meeting', 'agent'] as const;
export type PlaceId = (typeof PLACES)[number];

export const GESTURE_COPY = {
  place: {
    chat: 'a message you sent',
    'pr-comment': 'a review comment you wrote',
    meeting: 'a meeting you were in',
    agent: 'something you told your assistant',
  },
  theirPlace: {
    chat: 'a message they sent',
    'pr-comment': 'a review comment they wrote',
    meeting: 'a meeting you were both in',
    agent: 'something they told their assistant',
  },

  confirm: {
    heading: COPY.inbox.heading,
    /** Provenance, in the interface's own voice. The words themselves are quoted below it. */
    from: (place: string): string => `From ${place}.`,
    consequence: COPY.inbox.consequence,
    /** The promiser's half lands at once; the other half is never an interruption. */
    theirHalf: 'They sign their half whenever they next read their own.',
  },

  /** A fresh capture: there is nothing pending to accept or throw away, so the tap records. */
  record: {
    heading: 'To record',
    action: 'Record this',
    consequence: 'Nothing is recorded until you tap.',
  },

  /**
   * M-1 said to a person, on the card, in the one place where somebody would otherwise try
   * to promise on another person's behalf.
   */
  expectation: {
    heading: 'To note',
    from: (who: string, place: string): string => `${who}, in ${place}.`,
    action: 'Note what you are waiting for',
    consequence: 'Nothing is recorded until you note it. Only they can promise this.',
  },

  meeting: {
    heading: 'After the meeting',
    lede: 'What was said, as it was said. Nothing is recorded until you confirm.',
  },

  /**
   * §7 advertises five actions on an open item and names a tool for none of them. Rather
   * than invent one, a gesture that would take such an action says so and does nothing.
   */
  unmapped: 'There is no action for this here yet.',
} as const;

/** Every string this package can render, flattened — what gate GL scans. */
export function allGestureCopyStrings(): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') out.push(value);
    else if (typeof value === 'function') {
      const produced = (value as (...args: string[]) => unknown)('someone', 'somewhere');
      if (typeof produced === 'string') out.push(produced);
    } else if (value !== null && typeof value === 'object') {
      for (const v of Object.values(value)) walk(v);
    }
  };
  walk(GESTURE_COPY);
  return out;
}
