import { z } from 'zod';
import {
  Iso8601Duration,
  ProtocolVersion,
  PublicKeyHex,
  Rfc3339,
  Sha256Hex,
  SignatureHex,
} from './primitives.js';

/**
 * §4 Edge (`layer: wire`) — the bilateral signed promise. M-3: edges are strictly two-party.
 */

/**
 * §4.2 — states that may legitimately be ASSERTED. `open` is deliberately absent: §4.3 marks
 * confirmed → open as "(implicit)" with no signer, so an explicit `open` assertion is invalid.
 */
export const AssertableState = z.enum([
  'proposed',
  'confirmed',
  'closed',
  'released',
  'expired',
  'disputed',
  'superseded',
]);
export type AssertableState = z.infer<typeof AssertableState>;

/**
 * States that may APPEAR in an assertion arriving over the wire, including `open`.
 *
 * The distinction is load-bearing. A hostile or buggy peer can put `open` in an assertion,
 * and §4.3 requires the node to *discard* it — with the reason
 * `implicit-transition-not-assertable`. If the parser rejected `open` outright, the node
 * could not report that reason, and an M-14 rejection would be indistinguishable from
 * malformed JSON. Syntax is the parser's job; assertability is the transition table's.
 */
export const WireAssertionState = z.enum([
  'proposed',
  'confirmed',
  'open',
  'closed',
  'released',
  'expired',
  'disputed',
  'superseded',
]);
export type WireAssertionState = z.infer<typeof WireAssertionState>;

/** §4.3: `open` is reachable only implicitly from `confirmed`; it is never assertable. */
export const NON_ASSERTABLE_STATES: readonly string[] = ['open'] as const;

/**
 * Effective edge state as computed from the assertion chain.
 * - `none`: nothing valid has been asserted yet.
 * - `open`: §4.3 folds `confirmed` into `open` — confirmed ≡ open.
 * - `pending-acceptance`: models the §4.4 acceptance window, which §4.3 has no row for.
 *   This is the vectors' interpretation #4, not normative spec text.
 */
export const EffectiveState = z.enum([
  'none',
  'proposed',
  'open',
  'pending-acceptance',
  'closed',
  'released',
  'expired',
  'disputed',
  'superseded',
]);
export type EffectiveState = z.infer<typeof EffectiveState>;

/** States from which no further assertion is accepted. `disputed` is NOT terminal (§4.3). */
export const TERMINAL_STATES: readonly EffectiveState[] = [
  'closed',
  'released',
  'expired',
  'superseded',
] as const;

export const ClosurePolicy = z.enum(['on-evidence', 'on-acceptance']);
export type ClosurePolicy = z.infer<typeof ClosurePolicy>;

/**
 * The window this node writes when it CREATES an `on-acceptance` edge. It is not a fallback.
 *
 * §4.1 has no default: `acceptance_window` is required non-null iff `closure_policy` is
 * `on-acceptance`, and null otherwise (upstream #5). A verifier that supplied this value for an
 * edge that omitted one would be inventing a term neither party signed — which is why
 * `verifyAssertionChain` rejects such an edge outright with `malformed-edge-acceptance-window`
 * rather than reaching for this constant.
 *
 * Here it is only ever written INTO an edge, so the window the counterparty sees is one the edge
 * states explicitly and both parties sign against.
 */
export const DEFAULT_ACCEPTANCE_WINDOW = 'P5D';

/** §4.7 collective edges — owner is a group key. */
export const Fulfillment = z.object({
  policy: z.enum(['all', 'any', 'k-of-n']),
  k: z.number().int().positive().optional(),
  children: z.array(Sha256Hex).default([]),
  coordinator: PublicKeyHex.optional(),
});
export type Fulfillment = z.infer<typeof Fulfillment>;

export const Edge = z.object({
  v: ProtocolVersion,
  type: z.literal('edge'),
  /** §4.1: sha256(commitment_hash || owner || owed_to || proposed_at). */
  edge_id: Sha256Hex,
  commitment_hash: Sha256Hex,
  owner: PublicKeyHex,
  owed_to: PublicKeyHex,
  proposed_at: Rfc3339,
  /** Duplicated from the commitment so the counterparty can verify expiry without plaintext. */
  due: Rfc3339.nullable(),
  closure_policy: ClosurePolicy,
  acceptance_window: Iso8601Duration.nullable(),
  blocked_by: z.array(Sha256Hex).default([]),
  fulfillment: Fulfillment.optional(),
  supersedes: Sha256Hex.nullable(),
});
export type Edge = z.infer<typeof Edge>;

/**
 * §4.7 + M-9: "a collective edge MUST have either `fulfillment.children` whose union covers
 * fulfillment, or `fulfillment.coordinator`. Otherwise nodes MUST mark it unverifiable (no
 * auto-escalation)."
 *
 * It lives here, beside the `Edge` schema, because it is a property of an edge rather than of
 * any one consumer. `@servanda/node` and `@servanda/adapters` both decide verifiability and
 * neither depends on the other, so before this it existed as two byte-identical copies kept in
 * step by an agreement test. A rule with one home cannot drift out of step with itself.
 *
 * "Covers fulfillment" is not defined in checkable terms for `all`/`any`; the narrowest reading
 * a node can enforce without inventing semantics is: children must be non-empty, and under
 * `k-of-n` there must be a k the children could actually satisfy.
 */
export function collectiveDecompositionValid(edge: Edge): boolean {
  const f = edge.fulfillment;
  if (!f) return true; // not a collective edge
  if (f.coordinator) return true;
  if (f.children.length === 0) return false;
  if (f.policy === 'k-of-n') return f.k !== undefined && f.k > 0 && f.k <= f.children.length;
  return true;
}

/** §4.2 — every transition is a signed assertion. */
export const Assertion = z.object({
  v: ProtocolVersion,
  type: z.literal('assertion'),
  edge_id: Sha256Hex,
  /** Wire-level: `open` parses but is discarded by the transition table (M-14). */
  state: WireAssertionState,
  asserted_at: Rfc3339,
  by: PublicKeyHex,
  evidence_hash: Sha256Hex.nullable(),
  sig: SignatureHex,
});
export type Assertion = z.infer<typeof Assertion>;

export const UnsignedAssertion = Assertion.omit({ sig: true });
export type UnsignedAssertion = z.infer<typeof UnsignedAssertion>;

/**
 * The reasons a conforming node discards an assertion (M-14, §4.3).
 * These strings are the vocabulary the conformance vectors assert on — they are part of the
 * contract with the suite, not free-form diagnostics.
 */
export const RejectionReason = z.enum([
  'wrong-signer-for-transition',
  'signer-not-a-party',
  'illegal-source-state',
  'evidence-hash-required',
  'evidence-hash-required-for-owner-closure',
  'due-is-null',
  'expiry-before-due',
  'acceptance-window-not-elapsed',
  'malformed-edge-acceptance-window',
  'implicit-transition-not-assertable',
  'invalid-signature',
  'terminal-state-reached',
  'edge-id-mismatch',
  'duplicate-assertion-by-same-party',
]);
export type RejectionReason = z.infer<typeof RejectionReason>;

export interface AssertionOutcome {
  index: number;
  accepted: boolean;
  rejection_reason?: RejectionReason;
}
