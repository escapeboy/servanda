import { z } from 'zod';
import { Commitment, Sha256Hex } from '@servanda/types';
import type { Edge, Envelope, EvidenceRef } from '@servanda/types';
import { EvidenceBundle, evidenceHash } from './bundle.js';
import type { AdapterName } from './bundle.js';

/**
 * The verification adapter interface: `(commitment, context) → EvidenceBundle | NotVerifiable`.
 *
 * An adapter **observes**. It does not act, it does not assert, it does not sign, and it does
 * not close an edge — closing is the owner's signed act (§4.4), and M-13 keeps automation out
 * of the party role. Note what this file does not declare, in the same spirit as
 * `@servanda/executors`' capability set: there is no `sign`, no key of any kind reachable from
 * the context, no writer of any sort, and no network client. Not "you may not sign" — there is
 * nothing here to sign with.
 */

/**
 * A §3.1 commitment with `intent` removed and its §3.2 hash attached.
 *
 * `evidence_refs` is deliberately KEPT, unlike `@servanda/executors`, because the refs *are*
 * the claim an adapter is asked to check — an adapter with no refs has nothing to look at.
 * The safety property is moved rather than dropped: no ref value ever reaches a filesystem, a
 * git invocation, or anything else as free text. Every one is parsed against the closed
 * grammar in `refs.ts` first, and a value that does not fit is refused (§9.2, M-6).
 */
export const AdapterCommitment = Commitment.omit({ intent: true }).extend({
  commitment_hash: Sha256Hex,
});
export type AdapterCommitment = z.infer<typeof AdapterCommitment>;

/**
 * The world an adapter can observe. Everything is injected and everything is read-only.
 *
 * Each capability is optional, and its absence is not an error — it is the ordinary reason an
 * adapter cannot speak to a ref (`adapter-capability-absent`). A node with no git repository
 * on hand does not fail; it reports that the edge is not verifiable here, and M-8 does the rest.
 */
export interface ObservationContext {
  /**
   * RFC 3339. Injected so that an adapter is a pure function of its inputs and its bundle
   * hashes reproducibly. Nothing in this package reads the clock.
   */
  readonly now: string;
  /** Root for the `file` adapter. Read-only; paths that escape it are refused, not clamped. */
  readonly workspace?: { readonly root: string } | undefined;
  /** A local git repository for the `git` adapter. Read-only, offline, allowlisted plumbing. */
  readonly repo?: { readonly path: string } | undefined;
  /**
   * §2 envelopes already received into the vault, for the `ci` adapter. Evidence is a signal
   * that already arrived — an adapter never goes and fetches one.
   */
  readonly envelopes?: readonly Envelope[] | undefined;
  /** The edge, when the commitment has one. Carries §4.7 `fulfillment` for the M-9 check. */
  readonly edge?: Edge | undefined;
}

/**
 * Why nothing could be observed. These are conditions, not errors: `NotVerifiable` is a
 * first-class result, and M-8 then forbids auto-escalation.
 */
export const NotVerifiableReason = z.enum([
  /** The commitment names no evidence at all — there is nothing for an adapter to look at. */
  'no-evidence-refs',
  /** Refs are present, but no adapter in the registry can speak to any of them (M-8). */
  'no-adapter-for-evidence',
  /** An adapter matched the ref kind, but the context did not give it the world it needs. */
  'adapter-capability-absent',
  /**
   * The evidence was found and is not readable as an observation of this kind — e.g. an
   * envelope that is not a CI check run, or one carrying no conclusion. Distinct from
   * "observed and unsatisfied", which is a bundle with `satisfied: false`, not this.
   */
  'evidence-not-observable',
  /** The ref value does not fit the adapter's grammar; refused rather than guessed at. */
  'malformed-evidence-ref',
  /** Observing it would need the network, and adapters are offline by default. */
  'requires-network',
  /** §4.7 / M-9: a collective edge with neither a covering decomposition nor a coordinator. */
  'collective-without-decomposition-or-coordinator',
]);
export type NotVerifiableReason = z.infer<typeof NotVerifiableReason>;

/** An adapter looked and produced evidence. `evidence_hash` is what the assertion carries. */
export interface Observed {
  readonly verifiable: true;
  readonly bundle: EvidenceBundle;
  readonly evidence_hash: string;
}

/**
 * An adapter could not speak to this edge.
 *
 * `evidence_hash` is present and `null` on purpose. A caller that ignores the `verifiable`
 * discriminant and reaches straight for the hash — the careless path — gets `null`, puts `null`
 * in its `closed` assertion, and `verifyAssertionChain` discards it with
 * `evidence-hash-required-for-owner-closure`. The careless path is the safe path; you have to
 * work at it to build an unsafe one.
 */
export interface NotVerifiable {
  readonly verifiable: false;
  readonly reason: NotVerifiableReason;
  readonly detail: string;
  readonly evidence_hash: null;
  readonly bundle: null;
}

export type VerificationOutcome = Observed | NotVerifiable;

export function notVerifiable(reason: NotVerifiableReason, detail: string): NotVerifiable {
  return { verifiable: false, reason, detail, evidence_hash: null, bundle: null };
}

/** Wrap a bundle as an outcome, hashing it. The only way an `Observed` is constructed. */
export function observed(bundle: EvidenceBundle): Observed {
  const parsed = EvidenceBundle.parse(bundle);
  return { verifiable: true, bundle: parsed, evidence_hash: evidenceHash(parsed) };
}

/**
 * One adapter. `declares` is what it can observe: the §3.1 `EvidenceRef.kind`s it will look at.
 * Anything else it refuses — the registry never hands it a ref it did not declare, and the
 * adapter re-checks anyway, because "the caller wouldn't do that" is not a containment property.
 */
export interface VerificationAdapter {
  readonly name: AdapterName;
  readonly declares: readonly EvidenceRef['kind'][];
  readonly summary: string;
  readonly observe: (
    commitment: AdapterCommitment,
    ref: EvidenceRef,
    context: ObservationContext,
  ) => VerificationOutcome;
}
