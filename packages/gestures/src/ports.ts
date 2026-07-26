import type { VerificationLevel } from '@servanda/types';
import type { Delivery, GestureCard } from './card.js';
import type { UtteranceRef } from './utterance.js';

/**
 * The two things this package needs from the outside, as injected interfaces.
 *
 * Neither of them is implemented here, and that is the point: a gesture surface that opened
 * a connection would be a gesture surface that could be made to open one by the message it
 * arrived with. Nothing in `@servanda/gestures` imports a network module, and gate GL proves
 * it the way gate GA proves it for the node — a static scan of the shipped modules and a run
 * of every gesture path in a process whose network primitives throw.
 *
 * Whoever wires a platform up supplies both. A test supplies the two null objects below.
 */

/** Who a platform id belongs to, and what stands behind the answer. Synchronous by design. */
export interface PersonaDirectory {
  lookup(externalId: string): { readonly personaId: string; readonly verification: VerificationLevel } | null;
}

/** Nobody is resolvable. Every gesture then lands on somebody unknown, which is level 0. */
export const NO_DIRECTORY: PersonaDirectory = {
  lookup: () => null,
};

/** A directory backed by a plain map, for tests and for connectors that already hold one. */
export function directoryOf(
  entries: Readonly<Record<string, { personaId: string; verification: VerificationLevel }>>,
): PersonaDirectory {
  return { lookup: (externalId) => entries[externalId] ?? null };
}

export interface CardPlacement {
  /** Where the card goes: under the words it is about. */
  readonly ref: UtteranceRef;
  readonly delivery: Delivery;
  readonly card: GestureCard;
}

/**
 * Whoever puts the card in front of the person. A chat app posts an ephemeral message, a
 * review surface adds a reaction, a terminal prints it. This package builds the card and
 * hands it over; it never delivers one itself.
 */
export interface GesturePoster {
  post(placement: CardPlacement): void | Promise<void>;
}

/** Delivers nowhere. The default, so that forgetting to inject one cannot send anything. */
export const NO_POSTER: GesturePoster = {
  post: () => undefined,
};

export async function deliver(card: GestureCard, poster: GesturePoster): Promise<CardPlacement> {
  const placement: CardPlacement = { ref: card.ref, delivery: card.delivery, card };
  await poster.post(placement);
  return placement;
}
