import { ExtractedCommitment, Expectation, PROTOCOL_VERSION } from '@servanda/types';
import type { EvidenceRef } from '@servanda/types';
import type { RawExtraction } from './schema.js';

/**
 * §3.4 routing — what a node is allowed to do with an extraction result, given whose node it is.
 *
 * The rule this file exists to make structural is M-1: *you cannot propose someone else's
 * promise.* Note what is missing below: there is no branch, and no exported function anywhere in
 * this package, that constructs a §3.1 Commitment whose `owner` is not the node's own persona.
 * When the owner is someone else the only object that can be built is a §3.3 expectation — which
 * ADR-0013 keeps off the wire entirely. The illegal object is not merely never built; there is no
 * code that could build it.
 *
 * Spec ambiguity (narrowest reading taken, reported):
 *   §3.4 says cross-person results "MUST be created with source:'extracted'", which reads as
 *   though a Commitment object exists whose owner is another person. But §3.1 types `owner` as
 *   `persona_id | group_pubkey` — unlike `owed_to`, it admits no `external_label` — and §3.3 says
 *   in as many words that "the correct object for 'they said they would' is an expectation". So
 *   for owner ≠ persona this package builds an expectation, never a commitment. `source:
 *   "extracted"` is preserved on the commitments it *does* build (owner = persona), where the
 *   §3.1 field exists.
 */

/** A commitment the local user made to nobody in particular. Never leaves the vault (§3.1). */
export const REFLEXIVE = 'reflexive' as const;
/** Owner is the local user, counterparty is a reachable persona. Wire-eligible *after* a human act. */
export const PROPOSABLE_AFTER_CONFIRMATION = 'proposable-after-confirmation' as const;
/** Owner is the local user, counterparty is an off-network label. Half-network case (§3.1). */
export const VAULT_LOCAL_COUNTERPARTY_UNRESOLVED = 'vault-local-counterparty-unresolved' as const;
/** Owner is someone else. Expectation only, never proposable, never on the wire (M-1, ADR-0013). */
export const EXPECTATION_ONLY = 'expectation-only' as const;

export type Disposition =
  | typeof REFLEXIVE
  | typeof PROPOSABLE_AFTER_CONFIRMATION
  | typeof VAULT_LOCAL_COUNTERPARTY_UNRESOLVED
  | typeof EXPECTATION_ONLY;

/**
 * The one shape from which a wire `propose` may eventually be built — and only by way of an
 * explicit local-user confirmation (see `confirmProposal`). Produced solely by `route`.
 */
export interface ProposableResult {
  readonly disposition: typeof PROPOSABLE_AFTER_CONFIRMATION;
  readonly commitment: ExtractedCommitment;
  /** The counterparty's persona id. Present because it resolved; that is what makes it wire-eligible. */
  readonly counterparty: string;
}

export interface ReflexiveResult {
  readonly disposition: typeof REFLEXIVE;
  readonly commitment: ExtractedCommitment;
}

export interface VaultLocalResult {
  readonly disposition: typeof VAULT_LOCAL_COUNTERPARTY_UNRESOLVED;
  readonly commitment: ExtractedCommitment;
  readonly counterpartyLabel: string;
}

export interface ExpectationResult {
  readonly disposition: typeof EXPECTATION_ONLY;
  readonly expectation: Expectation;
  /** Whose promise this is, as read from the signal — a label, or a persona id if it resolved. */
  readonly from: string;
}

export type Routed = ReflexiveResult | ProposableResult | VaultLocalResult | ExpectationResult;

export type RoutingFailure = { readonly reason: string; readonly detail: string };

export type RoutingOutcome =
  | { readonly ok: true; readonly routed: Routed }
  | { readonly ok: false; readonly failure: RoutingFailure };

export interface RoutingContext {
  /** The persona this extraction run is bound to (M-5). Its owner is the only owner we can write. */
  readonly persona: string;
  /** `created_at` stamped on constructed objects; RFC 3339. */
  readonly createdAt: string;
  /**
   * Resolve a name written in a signal to a persona id, if the node knows one. Returning null is
   * the honest default: an unresolved counterparty means the half-network case, not a guess.
   */
  readonly resolveParty?: (label: string) => string | null;
}

function evidenceFor(result: RawExtraction): EvidenceRef[] {
  return [{ kind: 'envelope', value: result.envelope_id }];
}

function buildCommitment(
  result: RawExtraction,
  ctx: RoutingContext,
  owedTo: string | null,
): { ok: true; value: ExtractedCommitment } | { ok: false; failure: RoutingFailure } {
  const parsed = ExtractedCommitment.safeParse({
    v: PROTOCOL_VERSION,
    type: 'commitment',
    intent: result.intent,
    // The only owner this package can write. Not a policy — the value is not otherwise reachable.
    owner: ctx.persona,
    owed_to: owedTo,
    due: result.due,
    conditions: [],
    evidence_refs: evidenceFor(result),
    created_at: ctx.createdAt,
    source: 'extracted',
    confidence: result.confidence,
  });
  if (!parsed.success) {
    return { ok: false, failure: { reason: 'commitment-invalid', detail: parsed.error.message } };
  }
  return { ok: true, value: parsed.data };
}

function buildExpectation(
  result: RawExtraction,
  ctx: RoutingContext,
  from: string,
): { ok: true; value: Expectation } | { ok: false; failure: RoutingFailure } {
  const parsed = Expectation.safeParse({
    v: PROTOCOL_VERSION,
    type: 'expectation',
    expect: result.intent,
    from,
    since: ctx.createdAt,
    context_refs: evidenceFor(result),
    state: 'open',
  });
  if (!parsed.success) {
    return { ok: false, failure: { reason: 'expectation-invalid', detail: parsed.error.message } };
  }
  return { ok: true, value: parsed.data };
}

/**
 * §3.4, as a total function: a result plus the node's persona determines exactly one disposition.
 */
export function route(result: RawExtraction, ctx: RoutingContext): RoutingOutcome {
  const resolve = ctx.resolveParty ?? (() => null);

  // Owner is a different person → M-1 forbids a proposal *at all*, and §3.3 names the right
  // object. No commitment is constructed on this branch, so none can leak onto the wire.
  if (result.owner === 'other_party') {
    const label = result.owner_label as string;
    const resolved = resolve(label);
    // A resolved key that turns out to be us means the model mislabelled the author, not that we
    // may write a commitment for a third party. Treat it as ours: it is our own promise.
    if (resolved !== null && resolved === ctx.persona) {
      const built = buildCommitment(result, ctx, null);
      if (!built.ok) return { ok: false, failure: built.failure };
      return { ok: true, routed: { disposition: REFLEXIVE, commitment: built.value } };
    }
    const built = buildExpectation(result, ctx, resolved ?? label);
    if (!built.ok) return { ok: false, failure: built.failure };
    return {
      ok: true,
      routed: { disposition: EXPECTATION_ONLY, expectation: built.value, from: resolved ?? label },
    };
  }

  // Owner is the local user.
  if (result.owed_to === 'none' || result.owed_to === 'local_user') {
    // §3.1: reflexive is `owed_to: null`. "Owed to myself" is the same object.
    const built = buildCommitment(result, ctx, null);
    if (!built.ok) return { ok: false, failure: built.failure };
    return { ok: true, routed: { disposition: REFLEXIVE, commitment: built.value } };
  }

  const label = result.owed_to_label as string;
  const counterparty = resolve(label);

  if (counterparty === null) {
    // Half-network: `owed_to` is an external_label, so the record stays vault-local (§3.1).
    const built = buildCommitment(result, ctx, label);
    if (!built.ok) return { ok: false, failure: built.failure };
    return {
      ok: true,
      routed: {
        disposition: VAULT_LOCAL_COUNTERPARTY_UNRESOLVED,
        commitment: built.value,
        counterpartyLabel: label,
      },
    };
  }

  if (counterparty === ctx.persona) {
    const built = buildCommitment(result, ctx, null);
    if (!built.ok) return { ok: false, failure: built.failure };
    return { ok: true, routed: { disposition: REFLEXIVE, commitment: built.value } };
  }

  const built = buildCommitment(result, ctx, counterparty);
  if (!built.ok) return { ok: false, failure: built.failure };
  return {
    ok: true,
    routed: {
      disposition: PROPOSABLE_AFTER_CONFIRMATION,
      commitment: built.value,
      counterparty,
    },
  };
}

export function isProposable(routed: Routed): routed is ProposableResult {
  return routed.disposition === PROPOSABLE_AFTER_CONFIRMATION;
}

/** True for the dispositions §3.4 forbids ever turning into a wire `propose`. */
export function mayNeverPropose(routed: Routed): boolean {
  return !isProposable(routed);
}
