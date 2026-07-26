import type { VerificationLevel } from '@servanda/types';
import { COPY } from './copy.js';
import type { SealView } from './seal.js';
import { sealFor } from './seal.js';
import type { ActionView, PartyView } from './view.js';
import { partyFor, shortKey } from './view.js';

/**
 * The proof page — doctrine surface 7.
 *
 * A closed promise between two parties generates a certificate anyone with the link can
 * read: who, when, what happened in order, and the fingerprint the whole thing hangs on.
 *
 * Two properties make this surface worth building, and both are enforced here rather than
 * remembered:
 *
 *  1. **It renders from hashes alone.** The words of a promise are not an input to any part
 *     of this page except one clearly-labelled block. After the keeping period ends and the
 *     plaintext is gone (§5.4, ADR-0004, M-15) the certificate is *unchanged* — which is
 *     the whole point: you can still prove a promise was made and kept when nobody, not
 *     even the parties, can reconstruct its terms.
 *  2. **The words are never shown unless both parties agreed.** Consent is recorded per
 *     party, defaults to off, and is combined with `&&`. There is no argument to any
 *     function in this file by which one party could disclose on the other's behalf.
 */

export interface ProofPartyRecord {
  /** The party's key. Always present — a certificate without keys proves nothing. */
  readonly key: string;
  /** A display name, when one is known. Falls back to the key, shortened. */
  readonly display: string | null;
  readonly verification_level: VerificationLevel;
}

/** One signed assertion, reduced to what a certificate shows. */
export interface ProofStepRecord {
  readonly state: string;
  readonly asserted_at: string;
  readonly by: string;
  readonly evidence_hash: string | null;
}

/**
 * Consent to show the words, held per party. Both halves default to false and the page
 * combines them with `&&`; there is deliberately no single flag that could be flipped.
 */
export interface WordsDisclosure {
  readonly byOwner: boolean;
  readonly byOwedTo: boolean;
}

/** The default, and the only value a caller gets by omitting the field. */
export const WORDS_WITHHELD: WordsDisclosure = { byOwner: false, byOwedTo: false };

/** Who is reading. A stranger with the link is `public` and is offered nothing. */
export type ProofViewer = 'owner' | 'owed-to' | 'public';

export interface ProofRecord {
  readonly edge_id: string;
  readonly commitment_hash: string;
  readonly proposed_at: string;
  readonly due: string | null;
  readonly owner: ProofPartyRecord;
  readonly owed_to: ProofPartyRecord;
  /** In the order it happened. May be empty; the page still renders. */
  readonly chain: readonly ProofStepRecord[];
  /**
   * The words, if this machine still has them. `null` or omitted is the normal state of an
   * old promise, not an error condition (§5.4).
   */
  readonly plaintext?: string | null;
  /** Omitted means withheld. There is no "default open". */
  readonly disclosure?: WordsDisclosure;
  readonly viewer?: ProofViewer;
}

export interface ProofPartyView {
  readonly role: string;
  readonly party: PartyView;
  /** The full key, for anyone who wants to check it themselves. */
  readonly key: string;
}

export interface ProofStepView {
  readonly label: string;
  readonly when: string;
  readonly signedBy: string;
  readonly seal: SealView;
  readonly evidence: string | null;
}

export interface ProofDateView {
  readonly label: string;
  readonly value: string;
}

export interface ProofView {
  readonly heading: string;
  readonly lede: string;
  readonly outcome: string;
  readonly betweenHeading: string;
  readonly parties: readonly ProofPartyView[];
  readonly datesHeading: string;
  readonly dates: readonly ProofDateView[];
  readonly chainHeading: string;
  readonly chain: readonly ProofStepView[];
  readonly fingerprintHeading: string;
  readonly fingerprint: string;
  readonly fingerprintNote: string;
  readonly wordsHeading: string;
  /** Null unless the words exist AND both parties agreed. Null is the normal case. */
  readonly words: string | null;
  readonly wordsNote: string;
  /** Empty for a stranger with the link. At most one control, and it is a consent. */
  readonly actions: readonly ActionView[];
}

const CHAIN_LABELS: Record<string, string> = COPY.chain;

const OUTCOME_BY_STATE: Record<string, string> = {
  closed: COPY.proof.outcomeKept,
  expired: COPY.proof.outcomeOpen,
  released: COPY.proof.outcomeReleased,
  disputed: COPY.proof.outcomeDisputed,
  superseded: COPY.proof.outcomeReplaced,
};

function partyView(role: string, record: ProofPartyRecord): ProofPartyView {
  // M-12 travels with the certificate: the name and the evidence behind it come from one
  // call, exactly as they do on a card, so a proof page cannot flatter a name either. A
  // party with no display name falls back to its key, which `partyFor` sets in mono and
  // never dresses up.
  const named = record.display === null ? null : partyFor(record.display, record.verification_level);
  const party = named ?? partyFor(record.key, record.verification_level);
  if (party === null) throw new Error('a proof party must have a key');
  return { role, key: record.key, party };
}

function datesFor(record: ProofRecord): ProofDateView[] {
  const dates: ProofDateView[] = [
    { label: COPY.proof.promised, value: record.proposed_at },
  ];
  const agreed = record.chain.find((step) => step.state === 'confirmed');
  if (agreed !== undefined) dates.push({ label: COPY.proof.agreed, value: agreed.asserted_at });
  if (record.due !== null) dates.push({ label: COPY.proof.due, value: record.due });
  const settled = [...record.chain]
    .reverse()
    .find((step) => step.state in OUTCOME_BY_STATE);
  if (settled !== undefined) dates.push({ label: COPY.proof.settled, value: settled.asserted_at });
  return dates;
}

function stepView(step: ProofStepRecord): ProofStepView {
  return {
    label: CHAIN_LABELS[step.state] ?? COPY.chain.none,
    when: step.asserted_at,
    signedBy: COPY.proof.signedBy(shortKey(step.by)),
    seal: sealFor(step.state),
    evidence: step.evidence_hash === null ? null : shortKey(step.evidence_hash),
  };
}

/**
 * The consent control, offered to a party who has not yet given theirs — and only while
 * there are words left to show. Once the plaintext is gone the question is moot and the
 * page stops asking it.
 */
function consentActions(record: ProofRecord): ActionView[] {
  const viewer = record.viewer ?? 'public';
  if (viewer === 'public') return [];
  if (record.plaintext === null || record.plaintext === undefined) return [];
  const disclosure = record.disclosure ?? WORDS_WITHHELD;
  const mine = viewer === 'owner' ? disclosure.byOwner : disclosure.byOwedTo;
  if (mine) return [];
  return [
    {
      id: `${record.edge_id}:show-words`,
      label: COPY.proof.disclose,
      primary: true,
      dispatch: { kind: 'consent', consent: 'show-words', by: viewer },
    },
  ];
}

function wordsNote(record: ProofRecord, shown: boolean): string {
  if (shown) return COPY.proof.wordsShown;
  // The words being gone and the words being withheld are different facts, and the page
  // says which one it is. Conflating them would make retention decay look like a refusal.
  if (record.plaintext === null || record.plaintext === undefined) return COPY.proof.wordsGone;
  const viewer = record.viewer ?? 'public';
  const disclosure = record.disclosure ?? WORDS_WITHHELD;
  const mine = viewer === 'owner' ? disclosure.byOwner : viewer === 'owed-to' ? disclosure.byOwedTo : false;
  if (mine) return COPY.proof.discloseWaiting;
  return COPY.proof.wordsWithheld;
}

export function buildProof(record: ProofRecord): ProofView {
  const disclosure = record.disclosure ?? WORDS_WITHHELD;
  const bothAgreed = disclosure.byOwner && disclosure.byOwedTo;
  const have = record.plaintext !== null && record.plaintext !== undefined;
  const words = bothAgreed && have ? (record.plaintext as string) : null;

  const last = record.chain[record.chain.length - 1];

  return {
    heading: COPY.proof.heading,
    lede: COPY.proof.lede,
    outcome:
      last === undefined ? COPY.proof.outcomeOpen : (OUTCOME_BY_STATE[last.state] ?? COPY.proof.outcomeOpen),
    betweenHeading: COPY.proof.between,
    parties: [
      partyView(COPY.proof.roleOwner, record.owner),
      partyView(COPY.proof.roleOwedTo, record.owed_to),
    ],
    datesHeading: COPY.proof.dates,
    dates: datesFor(record),
    chainHeading: COPY.proof.chain,
    chain: record.chain.map(stepView),
    fingerprintHeading: COPY.proof.fingerprint,
    fingerprint: record.commitment_hash,
    fingerprintNote: COPY.proof.fingerprintNote,
    wordsHeading: COPY.proof.words,
    words,
    wordsNote: wordsNote(record, words !== null),
    actions: consentActions(record),
  };
}
