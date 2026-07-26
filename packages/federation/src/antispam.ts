import type { VerificationLevel } from '@servanda/types';

/**
 * §6.5 anti-spam / proposal budget.
 *
 * "A `proposed` edge is socially nothing (Sybil rule). Nodes SHOULD rate-limit inbound
 * proposals per unknown sender and MUST NOT surface proposals from level-0 senders above a
 * client-configurable cap. Expectation→proposal conversion MUST be user-initiated per
 * counterparty (no bulk auto-invites)."
 *
 * Two MUSTs and one SHOULD, kept apart on purpose:
 *  - the cap is a MUST, so `admit` refuses past it and the cap is a constructor argument
 *    ("client-configurable" means the client sets it, not that the library picks a number);
 *  - the per-sender rate limit is a SHOULD, implemented but overridable;
 *  - "no bulk auto-invites" is enforced by there being no bulk API at all — see
 *    `assertUserInitiatedConversion`, and note that no function in this package takes a list of
 *    counterparties.
 *
 * "Unknown sender" is read as verification level 0 (§1.6): no attestation, no prior confirmed
 * edge. That is exactly the population the Sybil rule is about.
 */

export type Admission =
  | { surface: true }
  | { surface: false; reason: 'rate-limited' | 'level-0-cap-reached' };

export interface ProposalBudgetOptions {
  /**
   * MUST (§6.5). The maximum number of level-0 proposals this client will surface.
   * There is no default: a library-chosen cap would not be client-configurable.
   */
  levelZeroCap: number;
  /** SHOULD (§6.5): inbound proposals admitted per unknown sender per window. */
  perUnknownSenderLimit?: number;
  windowMs?: number;
  now?: () => Date;
}

const DEFAULT_PER_SENDER_LIMIT = 3;
const DEFAULT_WINDOW_MS = 86_400_000;

export class ProposalBudget {
  private readonly cap: number;
  private readonly perSender: number;
  private readonly windowMs: number;
  private readonly clock: () => Date;
  private readonly recent = new Map<string, number[]>();
  private surfacedLevelZero = 0;

  constructor(opts: ProposalBudgetOptions) {
    if (!Number.isInteger(opts.levelZeroCap) || opts.levelZeroCap < 0) {
      throw new RangeError('§6.5: levelZeroCap must be a non-negative integer chosen by the client');
    }
    this.cap = opts.levelZeroCap;
    this.perSender = opts.perUnknownSenderLimit ?? DEFAULT_PER_SENDER_LIMIT;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.clock = opts.now ?? (() => new Date());
  }

  /**
   * May an inbound proposal from `sender` be surfaced? Counts are only advanced on a `true`
   * answer, so a suppressed proposal never consumes the cap it was refused by.
   */
  admit(sender: string, level: VerificationLevel): Admission {
    if (level !== '0') return { surface: true };

    const now = this.clock().getTime();
    const seen = (this.recent.get(sender) ?? []).filter((t) => now - t < this.windowMs);
    if (seen.length >= this.perSender) {
      this.recent.set(sender, seen);
      return { surface: false, reason: 'rate-limited' };
    }
    if (this.surfacedLevelZero >= this.cap) {
      this.recent.set(sender, seen);
      return { surface: false, reason: 'level-0-cap-reached' };
    }

    seen.push(now);
    this.recent.set(sender, seen);
    this.surfacedLevelZero++;
    return { surface: true };
  }

  /** How much of the §6.5 cap has been spent. Local to this node; not a reputation signal (M-11). */
  spent(): { levelZeroSurfaced: number; levelZeroCap: number } {
    return { levelZeroSurfaced: this.surfacedLevelZero, levelZeroCap: this.cap };
  }
}

export class BulkInviteRefused extends Error {
  override name = 'BulkInviteRefused';
}

/**
 * §6.5: "Expectation→proposal conversion MUST be user-initiated per counterparty (no bulk
 * auto-invites)."
 *
 * SPEC AMBIGUITY (narrowest reading; reported). §6.2 defines no `invite` message and §6.7 calls
 * the out-of-band bootstrap a `propose` carried by the *counterparty's* node — and M-1 forbids
 * proposing someone else's promise. So there is no wire object this function could emit that
 * the spec defines. What §6.5 constrains is therefore modelled as what it literally is: a
 * precondition on the act, checked at the one point a client can perform it. One counterparty,
 * one explicit user act, no array form anywhere in this package.
 */
export function assertUserInitiatedConversion(input: {
  expectation_id: string;
  counterparty: string;
  user_initiated: boolean;
}): void {
  if (!input.user_initiated) {
    throw new BulkInviteRefused(
      '§6.5: expectation→proposal conversion MUST be user-initiated per counterparty; ' +
        'there is no automatic or bulk form of this act.',
    );
  }
  if (!/^[0-9a-f]{64}$/.test(input.counterparty)) {
    throw new BulkInviteRefused('§6.5: conversion targets exactly one counterparty persona');
  }
}
