import { commitmentHash } from '@servanda/crypto';
import type { ExtractedCommitment } from '@servanda/types';
import { isProposable, PROPOSABLE_AFTER_CONFIRMATION } from './routing.js';
import type { ProposableResult, Routed } from './routing.js';

/**
 * Where extraction output lands: a queue of *proposals to a human*, not a ledger.
 *
 * §9.2 states the honest limit — LLM extraction is never injection-proof — and then states what
 * the architecture does guarantee instead: a fooled model can produce at most an unconfirmed
 * proposal, **nothing a human didn't sign**. That guarantee is this file. Nothing here writes to
 * a vault, a ledger, or the wire. The only way out of the queue is `confirmProposal`, which takes
 * a `ProposableResult` — a type `route` hands out for exactly one disposition — plus an explicit
 * confirmation from the local user. An expectation cannot be passed to it; the type does not fit.
 */

export interface PendingItem {
  /** Stable within a queue; not a protocol identifier. */
  readonly id: string;
  readonly routed: Routed;
  /** The envelope the result came from, for showing a human the evidence. */
  readonly envelopeId: string;
  /** The verbatim span the model claims states the commitment. */
  readonly quote: string;
  readonly confidence: number;
  readonly queuedAt: string;
}

export type PendingState = 'pending' | 'confirmed' | 'rejected';

/**
 * An explicit act by the local user. §3.4 requires one before any wire `propose`; it is
 * represented rather than assumed so that no code path can supply it implicitly.
 */
export interface LocalUserConfirmation {
  /** The persona performing the confirmation. Must be the commitment's owner (M-1). */
  readonly persona: string;
  readonly confirmedAt: string;
}

/**
 * A confirmed proposal — the handoff to the signing/wire layer, which owns the signature.
 * Reaching this type requires (a) `route` producing a proposable result and (b) a human act.
 */
export interface ConfirmedProposal {
  readonly kind: 'confirmed-proposal';
  readonly commitment: ExtractedCommitment;
  /** §3.2 wire identity of the promise. The plaintext stays in the vault (M-7). */
  readonly commitmentHash: string;
  readonly counterparty: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
}

export class NotProposableError extends Error {
  constructor(disposition: string) {
    super(
      `§3.4/M-1: a result routed as "${disposition}" can never become a wire propose ` +
        `(only "${PROPOSABLE_AFTER_CONFIRMATION}" can, and only after explicit confirmation)`,
    );
    this.name = 'NotProposableError';
  }
}

export class ConfirmationOwnerMismatchError extends Error {
  constructor(owner: string, confirmer: string) {
    super(`M-1: commitment owner ${owner} cannot be confirmed by ${confirmer}`);
    this.name = 'ConfirmationOwnerMismatchError';
  }
}

/**
 * Turn a proposable result into a confirmed proposal. The static type already excludes every
 * other disposition; the runtime check is here because this is the last gate before the wire and
 * a mis-cast at a call site must fail loudly rather than quietly ship someone else's promise.
 */
export function confirmProposal(
  result: ProposableResult,
  confirmation: LocalUserConfirmation,
): ConfirmedProposal {
  if (!isProposable(result)) {
    throw new NotProposableError((result as Routed).disposition);
  }
  if (result.commitment.owner !== confirmation.persona) {
    throw new ConfirmationOwnerMismatchError(result.commitment.owner, confirmation.persona);
  }
  return {
    kind: 'confirmed-proposal',
    commitment: result.commitment,
    commitmentHash: commitmentHash(result.commitment),
    counterparty: result.counterparty,
    confirmedBy: confirmation.persona,
    confirmedAt: confirmation.confirmedAt,
  };
}

/**
 * In-memory pending-confirmation queue. Deliberately not persistent: this package proposes,
 * it does not store protocol state.
 */
export class PendingConfirmationQueue {
  readonly #items: PendingItem[] = [];
  readonly #states = new Map<string, PendingState>();
  #next = 0;

  enqueue(entry: Omit<PendingItem, 'id'>): PendingItem {
    const item: PendingItem = { ...entry, id: `pending-${++this.#next}` };
    this.#items.push(item);
    this.#states.set(item.id, 'pending');
    return item;
  }

  list(state?: PendingState): readonly PendingItem[] {
    if (state === undefined) return [...this.#items];
    return this.#items.filter((i) => this.#states.get(i.id) === state);
  }

  stateOf(id: string): PendingState | undefined {
    return this.#states.get(id);
  }

  get size(): number {
    return this.#items.length;
  }

  /**
   * Record the local user's confirmation of one queued item.
   *
   * Throws for anything not routed proposable — including every expectation, which is what a
   * cross-person result becomes. There is no "confirm anyway" path.
   */
  confirm(id: string, confirmation: LocalUserConfirmation): ConfirmedProposal {
    const item = this.#items.find((i) => i.id === id);
    if (item === undefined) throw new Error(`unknown pending item: ${id}`);
    if (!isProposable(item.routed)) throw new NotProposableError(item.routed.disposition);
    const proposal = confirmProposal(item.routed, confirmation);
    this.#states.set(id, 'confirmed');
    return proposal;
  }

  reject(id: string): void {
    if (!this.#states.has(id)) throw new Error(`unknown pending item: ${id}`);
    this.#states.set(id, 'rejected');
  }
}
