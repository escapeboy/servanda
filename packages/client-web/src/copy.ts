/**
 * The one string table. Every word a person reads comes from here — web, terminal, email.
 *
 * Three laws from the interface doctrine are enforced by construction in this file rather
 * than remembered at each call site:
 *
 *  1. **Notary, not coach.** Plain verbs, sentence case, states not judgments. No
 *     exclamation marks anywhere; "open 12 days", never "overdue".
 *  2. **Human vocabulary.** Owe / waiting / closed. The words the protocol uses for its own
 *     objects stop at the API boundary and do not appear in anything a person reads.
 *  3. **Non-technical by default.** No sentence here requires knowing how the system is
 *     built in order to be understood.
 *
 * Gate GE greps this table and the rendered output of all three surfaces.
 */

export const COPY = {
  appName: 'Servanda',

  brief: {
    heading: 'Today',
    empty: 'Nothing is waiting on you today.',
    /** Everything the attention market ranked below the fold. Count, never a nudge. */
    belowTheLine: (n: number): string => (n === 1 ? '1 more, further down.' : `${n} more, further down.`),
    generated: (when: string): string => `As of ${when}.`,
  },

  sections: {
    owe: 'You owe',
    waiting: 'You are waiting',
    closed: 'Closed',
  },

  empty: {
    owe: 'You owe nothing that is still open.',
    waiting: 'You are waiting on nothing.',
    closed: 'Nothing closed yet.',
  },

  inbox: {
    heading: 'To confirm',
    empty: 'Nothing to confirm.',
    /** The whole point of the queue, said once: consent is the record. */
    consequence: 'Nothing is recorded until you confirm.',
  },

  /** With whom. */
  party: {
    justYou: 'Just you',
    unknown: 'Not named',
  },

  /**
   * Verification, said as degrees of seal relief. These replace identity terminology in the
   * interface entirely (M-12: the level is always displayed, and a name is never rendered
   * above the evidence that stands behind it).
   */
  trust: {
    '0': 'unconfirmed name',
    '1': 'same person as before',
    '2': 'vouched for',
    '3': 'verified at their domain',
    ext: 'verified elsewhere',
  },

  /** What the mark on the record means, in words, for anyone who cannot see the mark. */
  seal: {
    unsealed: 'not sent',
    half: 'sent, waiting for their half',
    joined: 'agreed by both',
    marked: 'closed and marked',
    cracked: 'disagreed',
    arrow: 'replaced by a newer one',
  },

  /**
   * What happens if I do nothing — the third question every card answers. States, never
   * judgments: a date that has passed is a fact about the date, not about the person.
   */
  consequence: {
    dueToday: 'Due today.',
    dueTomorrow: 'Due tomorrow.',
    dueInDays: (n: number): string => `Due in ${n} days.`,
    passedToday: 'The date passed today.',
    passedDays: (n: number): string =>
      n === 1 ? 'The date passed yesterday.' : `The date passed ${n} days ago.`,
    theirsToday: 'Their date is today.',
    theirsTomorrow: 'Their date is tomorrow.',
    theirsInDays: (n: number): string => `They have ${n} days left.`,
    theirsPassedToday: 'Their date passed today.',
    theirsPassedDays: (n: number): string =>
      n === 1 ? 'Their date passed yesterday.' : `Their date passed ${n} days ago.`,
    openNoDate: (days: number): string =>
      days === 1 ? 'No date. Open 1 day.' : `No date. Open ${days} days.`,
    waitingNoDate: (days: number): string =>
      days === 1 ? 'No date. Waiting 1 day.' : `No date. Waiting ${days} days.`,
    settled: 'Nothing further.',
  },

  /**
   * Action labels. The node offers a label of its own in `brief.slots[].primary_action`;
   * this client renders its own instead, because the voice of the interface is the
   * interface's responsibility and cannot be delegated to whatever is on the other end of
   * the connection. The node's choice of *which* action leads the card is honoured.
   */
  actions: {
    done: 'Mark done',
    release: 'Let it go',
    supersede: 'Change the date',
    delegate: 'Hand to someone',
    ping: 'Ask for an update',
    confirm: 'Confirm',
    dismiss: 'Not a promise',
  },

  nav: {
    brief: 'Today',
    owe: 'You owe',
    waiting: 'You are waiting',
    closed: 'Closed',
    inbox: 'To confirm',
  },

  email: {
    subject: (owed: number, waiting: number): string => `${owed} owed, ${waiting} waiting`,
    intro: 'Where things stand this morning.',
    footer: 'You are seeing this because you asked for a morning note.',
  },
} as const;

/** Every string a person can read, flattened — what the vocabulary gate scans. */
export function allCopyStrings(): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') out.push(value);
    else if (typeof value === 'function') {
      // Sample the parameterised lines at the plural boundaries they switch on.
      for (const n of [0, 1, 2, 7]) {
        const produced = (value as (...args: unknown[]) => unknown)(n, n);
        if (typeof produced === 'string') out.push(produced);
      }
    } else if (value !== null && typeof value === 'object') {
      for (const v of Object.values(value)) walk(v);
    }
  };
  walk(COPY);
  return out;
}
