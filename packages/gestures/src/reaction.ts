import type { OpenLoopAction } from '@servanda/types';
import type { GestureCard } from './card.js';
import { confirmCard, expectationCard, recordCard } from './card.js';
import type { UnmappedIntent } from './intent.js';
import { unmappedIntent } from './intent.js';
import type { Utterance } from './utterance.js';
import { asOwn } from './utterance.js';

/**
 * Reaction-confirm: the whole surface, as one pure function.
 *
 * A designated reaction on the message where the promise was spoken resolves to a card whose
 * leading action is a §7 intent. Nothing here reads a clock, touches a disk, or opens a
 * connection — the mapping from platform event to intent is a total function of its
 * arguments, which is what makes every law in this package testable by calling it.
 *
 * 🤝 is the designated one, and the choice is not decorative: the handshake is the gesture a
 * promise already has in the world, it costs no context switch, and it is visible to
 * everyone in the room — capture and confirmation in a single tap where the words are.
 *
 * The other reactions in the table exist to demonstrate the honest failure. `open_loops`
 * advertises done / release / delegate / ping and §7 names a tool for none of them
 * (issue #19). A ✅ therefore resolves to `UnmappedIntent` and does nothing, rather than to
 * an invented tool call that no conforming node would answer.
 */

export const CONFIRM_REACTION = '🤝';

/** Reactions that mean an advertised §7 action for which the surface names no tool. */
export const UNMAPPED_REACTIONS: Readonly<Record<string, OpenLoopAction>> = {
  '✅': 'done',
  '🙏': 'release',
  '↪️': 'delegate',
  '⏰': 'ping',
};

export interface ReactionEvent {
  /** The reaction, exactly as the platform reported it. */
  readonly reaction: string;
  /** The persona of the person who reacted. Never taken from the message body. */
  readonly by: string;
  readonly utterance: Utterance;
}

export type IgnoredReason = 'not-a-gesture' | 'nothing-said';

export type Resolution =
  | { readonly kind: 'card'; readonly card: GestureCard }
  | { readonly kind: 'unmapped'; readonly intent: UnmappedIntent }
  | { readonly kind: 'ignored'; readonly reason: IgnoredReason };

/**
 * The mapping, in full:
 *
 *   🤝 on your own words, extraction pending  → confirm card (confirm · dismiss)
 *   🤝 on your own words, nothing pending     → record card  (commit)
 *   🤝 on somebody else's words               → expectation card (expect · dismiss)
 *   ✅ 🙏 ↪️ ⏰                                 → unmapped, and nothing happens
 *   🤝 on a body that scrubs down to nothing  → ignored, nothing-said
 *   anything else                             → ignored, not-a-gesture
 *
 * The third line is M-1. There is no fourth line in which somebody else's promise becomes a
 * proposal, and there is no argument to this function that produces one.
 */
export function resolveReaction(event: ReactionEvent): Resolution {
  if (event.reaction !== CONFIRM_REACTION) {
    const action = UNMAPPED_REACTIONS[event.reaction];
    if (action === undefined) return { kind: 'ignored', reason: 'not-a-gesture' };
    return { kind: 'unmapped', intent: unmappedIntent(action) };
  }

  // A message that is nothing but control characters has no words to quote, and a card whose
  // first question has no answer is not a card. This is the honest end of M-6: the body was
  // scrubbed down to nothing, so nothing is what it produces.
  if (event.utterance.text.length === 0) return { kind: 'ignored', reason: 'nothing-said' };

  const mine = asOwn(event.utterance, event.by);
  if (mine === null) {
    return { kind: 'card', card: expectationCard(event.utterance, event.utterance.ref.value) };
  }
  if (mine.pendingId === null) {
    return { kind: 'card', card: recordCard(mine, mine.ref.value) };
  }
  return { kind: 'card', card: confirmCard(mine, mine.pendingId) };
}
