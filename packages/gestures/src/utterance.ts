import type { VerificationLevel } from '@servanda/types';
import type { PlaceId } from './copy.js';
import type { Quoted } from './quote.js';

/**
 * What a gesture arrives with: somebody said something, somewhere, and somebody reacted.
 *
 * This module is where M-1 is decided, and it is decided by types rather than by a check.
 *
 * A promise is owned by its giver. A gesture may therefore confirm *your own* promise and
 * may never assert somebody else's — "they said they would" is an expectation, never a
 * proposal on their behalf (§3.4, §8 M-1). The way that is made unrepresentable here:
 *
 *  - An `Utterance` names its speaker and carries no owner field at all. Nothing in a
 *    payload can say whose promise this is; the speaker is all there is.
 *  - `OwnUtterance` is a branded subtype with exactly one constructor, `asOwn`, which
 *    returns null unless the speaker's persona is the confirming person's own.
 *  - The card builders that can emit `commit` or an accepting `confirm` take `OwnUtterance`
 *    and nothing else. Handing one a plain `Utterance` is a compile error, not a runtime
 *    rejection — there is no branch to test because there is no branch.
 *
 * The remaining question is what a gesture on somebody else's words does. It records an
 * expectation, held by the person who made the gesture, which never leaves their own machine
 * (§3.3, ADR-0013). That is a different card with different intents.
 */

export interface Speaker {
  /** What a payload calls them. Attacker-authored, so it arrives quoted. */
  readonly display: Quoted;
  /** The platform's own id for them. Never rendered, never an owner. */
  readonly externalId: string;
  /** Resolved by an injected directory, or null when this person is not on the network. */
  readonly personaId: string | null;
  /** M-12: what stands behind the name. Absent evidence is level 0, never a blank. */
  readonly verification: VerificationLevel;
}

/** Where the words are, so a card can point back at them without fetching anything. */
export interface UtteranceRef {
  readonly kind: 'message' | 'url';
  readonly value: string;
}

export interface Utterance {
  readonly place: PlaceId;
  readonly ref: UtteranceRef;
  readonly speaker: Speaker;
  /** The words. Quoted, never interpreted (M-6). */
  readonly text: Quoted;
  readonly occurredAt: string;
  /**
   * An extraction already waiting in the local confirmation queue for these words, if there
   * is one. Its presence is what turns a gesture from a capture into a confirmation.
   */
  readonly pendingId: string | null;
  /** Who the promise would be owed to, when the words name somebody. */
  readonly owedTo: Speaker | null;
}

declare const ownBrand: unique symbol;

/** An utterance the confirming person made themselves. The only thing they may commit. */
export type OwnUtterance = Utterance & { readonly [ownBrand]: 'own' };

/**
 * The single gate from "somebody said something" to "I said this". A speaker with no
 * resolved persona is never mine, which also closes the case where two people share a
 * display name and one of them is not on the network at all.
 */
export function asOwn(utterance: Utterance, viewer: string): OwnUtterance | null {
  if (utterance.speaker.personaId === null) return null;
  if (utterance.speaker.personaId !== viewer) return null;
  return utterance as OwnUtterance;
}

/** True when the words are somebody else's. The complement of `asOwn`, said positively. */
export function isSomeoneElses(utterance: Utterance, viewer: string): boolean {
  return asOwn(utterance, viewer) === null;
}
