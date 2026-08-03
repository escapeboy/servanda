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

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/**
 * An instant, for a person. `2026-07-27T03:34:55.588Z` → `27 July 2026, 03:34 UTC`.
 *
 * Written out rather than handed to `toLocaleString`, which reads the machine's locale and
 * time zone: the same brief would then render differently on the laptop that composed it and
 * the server that mailed it, and no test could pin either. Law 3 above is the reason this
 * exists at all — a timestamp with milliseconds and a `Z` requires knowing how the system is
 * built, which is exactly what this table promises never to require.
 *
 * UTC is named rather than converted, because converting would need a zone this module is
 * forbidden to read. An unparseable value is returned untouched: showing the raw string is
 * honest, and inventing a date is not.
 */
export function readableInstant(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/u.exec(iso);
  if (m === null) return iso;
  const month = MONTHS[Number(m[2]) - 1];
  if (month === undefined) return iso;
  return `${Number(m[3])} ${month} ${m[1]}, ${m[4]}:${m[5]} UTC`;
}

export const COPY = {
  appName: 'Servanda',

  brief: {
    heading: 'Today',
    empty: 'Nothing is waiting on you today.',
    /** Everything the attention market ranked below the fold. Count, never a nudge. */
    belowTheLine: (n: number): string => (n === 1 ? '1 more, further down.' : `${n} more, further down.`),
    generated: (when: string): string => `As of ${readableInstant(when)}.`,
    /**
     * What was ranked for this morning and could not be shown. It is one line and it is
     * unavoidable: a brief that quietly drops what it was given is a brief that says "nothing
     * is waiting on you" while something is. The reason cannot be stated here — it is that the
     * ranking crosses contexts and the read does not — because naming it needs the machinery
     * words this table exists to keep off the surface. The count is the part that matters.
     */
    unresolved: (n: number): string =>
      n === 1
        ? '1 more was ranked for this morning and is kept somewhere this view cannot reach.'
        : `${n} more were ranked for this morning and are kept somewhere this view cannot reach.`,
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
  /**
   * What stands where a name would, when the node sent one its evidence does not support.
   *
   * Client copy, and it has to be: M-21 forbids the node supplying wording, and M-12 forbids
   * showing the name. Something must occupy the place so the card still says WHO this is about —
   * "someone" is honest, and it is the client's own word.
   */
  unevidencedParty: 'someone',

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
    /**
     * `contested-closure`, and it needs its own sentence for the same reason it needed a name.
     *
     * Without one it fell through to the date arithmetic and read the edge's `due` — so the
     * person who closed a promise with evidence three days ago was told "Due tomorrow." The
     * question this line answers is "what happens if I do nothing", and here the honest answer
     * is that the disagreement stands until one of you replaces it or the window runs out.
     */
    contested: 'Both of you ended it, differently. It stands until you agree or the window runs out.',
    /** `disputed` had the same gap and the same wrong sentence. */
    disputed: 'Disagreed. It stands until you agree or replace it.',
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
    /**
     * §4.4's escape from a deadlock, offered to whoever is trapped once the window has run.
     *
     * Worded as an ending and not as a verdict, because that is what the act is: §4.4 says both
     * parties' assertions stay in the chain and the outcome names a window, never who was right.
     * "Close it unresolved" would be a judgement; "Let the time run out" would suggest waiting is
     * still required when the waiting is what just finished.
     */
    expire: 'End it, unsettled',
    confirm: 'Confirm',
    dismiss: 'Not a promise',
    propose: 'Send it to them',
  },

  nav: {
    brief: 'Today',
    owe: 'You owe',
    waiting: 'You are waiting',
    closed: 'Closed',
    inbox: 'To confirm',
    team: 'Standup',
    trust: 'Sources and trust',
  },

  /**
   * The chain of what happened, said as events rather than as states. The protocol's own
   * state names are correct and are the wrong thing to show a person who has never read it.
   */
  chain: {
    none: 'Nothing recorded yet',
    proposed: 'Sent for agreement',
    confirmed: 'Agreed by both',
    open: 'Under way',
    'pending-acceptance': 'Delivered, waiting to be accepted',
    closed: 'Delivered and accepted',
    released: 'Let go by agreement',
    expired: 'The time ran out',
    disputed: 'Disagreed',
    // The only state a person had never met, because it was the only one with no sentence.
    // It is reached when both people act at the same moment without having seen each other —
    // one marks it done, the other lets it go. Both acts are legal and neither is discarded, so
    // the wording says what happened rather than naming a fault.
    'contested-closure': 'Both of you ended it, differently',
    superseded: 'Replaced by a newer promise',
  },

  /**
   * The proof page. It is the one surface a stranger reads, so it explains itself and
   * assumes nothing — and it says plainly what it is not showing and why.
   */
  proof: {
    heading: 'A promise, on the record',
    lede: 'Two people agreed to something and each signed their half. Anyone with this link can check it.',
    between: 'Between',
    roleOwner: 'Promised by',
    roleOwedTo: 'Promised to',
    dates: 'Dates',
    promised: 'Promised',
    agreed: 'Agreed',
    due: 'Due',
    settled: 'Settled',
    chain: 'What happened, in order',
    signedBy: (who: string): string => `Signed by ${who}`,
    evidence: 'Evidence attached',
    fingerprint: 'Fingerprint',
    fingerprintNote:
      'The same promise always produces this fingerprint, and nothing else produces it.',
    outcomeKept: 'Made, and kept.',
    outcomeReleased: 'Made, and let go by agreement.',
    outcomeDisputed: 'Made, and disagreed about.',
    outcomeReplaced: 'Made, and replaced by a newer promise.',
    outcomeOpen: 'Made, and still under way.',
    words: 'What was promised',
    /** Default. Neither party can lift this alone. */
    wordsWithheld: 'The words are not shown. Both people have to agree before they are.',
    /** After the keeping period ends: the point of the whole surface (M-15). */
    wordsGone:
      'The words are no longer kept. That the promise was made, and what became of it, remains.',
    wordsShown: 'Both people agreed to show the words.',
    disclose: 'Agree to show the words',
    discloseWaiting: 'You agreed. Waiting for the other person.',
  },

  /**
   * The team surface. A standup, not a scoreboard: it reports what is shared and what it
   * holds up, and it has no sentence in which a person is the subject of a judgement.
   */
  team: {
    heading: 'Standup',
    lede: 'Your standup writes itself.',
    empty: 'Nothing has been shared with this team.',
    note: 'Only what someone chose to share here appears. Nothing else does.',
    between: (a: string, b: string): string => `${a} and ${b}`,
    blocks: (what: string): string => `Holds up ${what}.`,
    blocksNothing: 'Holds up nothing else.',
  },

  /** Connected sources, and the leeway each kind of work has earned. */
  sources: {
    heading: 'Sources and trust',
    sourcesHeading: 'Where your promises come from',
    connected: 'Connected',
    notConnected: 'Not connected',
    lastRead: (when: string): string => `Last read ${when}.`,
    neverRead: 'Nothing read yet.',
    connect: 'Connect',
    disconnect: 'Disconnect',
    trustHeading: 'What it may do for you',
    trustLede:
      'Each kind of work earns its own leeway. These are not switches — a rung opens when the work behind it has earned it.',
    rungs: {
      suggest: 'Suggests, and nothing more',
      draft: 'Prepares a draft for you to look at',
      window: 'Acts, and tells you before it lands',
      silent: 'Acts on its own',
    },
    earned: 'Earned',
    standing: 'Where it stands now',
    lockedLabel: 'Not yet earned',
    ceilingLabel: 'This kind of work stops here',
    unlock: (n: number): string =>
      n === 1
        ? 'Opens after one more draft you approve unchanged.'
        : `Opens after ${n} more drafts you approve unchanged.`,
    ceiling: (label: string): string => `This kind of work never goes past “${label}”.`,
  },

  /**
   * First run. The law this block answers to: no sentence here may require knowing how the
   * thing is built in order to be understood, and the word "install" does not exist.
   */
  firstRun: {
    heading: 'Welcome',
    lede: 'Three short steps. The first useful thing arrives within the hour.',
    signUp: 'Sign up',
    signUpBlurb: 'Your work email, or the account you already sign in with.',
    connect: 'Connect your mail',
    connectBlurb:
      'One click. What you have already sent is enough to find the promises in it.',
    firstBrief: 'Your first note',
    firstBriefBlurb:
      'A short read: what you owe, what you are waiting for, and nothing else.',
    done: 'Done',
    next: 'Continue',
    custody:
      'We look after this for you, the way your mail provider does. If you would rather hold it yourself, you can.',
    recoveryHeading: 'Recovery sheet',
    recoveryBlurb:
      'One page to print and keep somewhere safe. If you ever lose your way back in, these words bring everything back.',
    recoveryWords: (n: number): string => `Your ${n} words`,
    recoveryPrint: 'Print the sheet',
    recoverySkip: 'Skip for now',
    recoveryLater: 'You can print it later, from Sources and trust.',
  },

  /**
   * Which register you are looking at — your own promises, or the invented ones.
   *
   * This line lived in the terminal's entry point, written by hand and outside this table, so
   * gate GE never scanned the one sentence the terminal prints on every frame: it said "vault"
   * and "persona", two of the seven words this table exists to keep off a surface. The env
   * variable names survive the scan because `SERVANDA_VAULT` is one word, and they are the
   * literal thing to type.
   */
  source: {
    demonstration:
      'DEMONSTRATION — these promises are invented. Set SERVANDA_VAULT and SERVANDA_PASSPHRASE to read your own.',
    yours: (where: string, who: string): string => `Your own promises · ${where} · ${who}`,
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
