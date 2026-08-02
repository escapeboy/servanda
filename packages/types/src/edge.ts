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
 * - `contested-closure`: two parties each took a legal unilateral exit from `open`, concurrently.
 *   Computed, never asserted — see the long note on `TERMINAL_STATES` below.
 */
export const EffectiveState = z.enum([
  'none',
  'proposed',
  'open',
  'pending-acceptance',
  'closed',
  'released',
  'expired',
  'contested-closure',
  'disputed',
  'superseded',
]);
export type EffectiveState = z.infer<typeof EffectiveState>;

/**
 * §4.3: the exits `open` offers to ONE party acting alone. They are mutually exclusive, and
 * nothing stops two parties taking different ones at the same time.
 *
 * `closed` is the owner's (with evidence); `released` is `owed_to`'s; `expired` is either party's
 * once `due` has passed. `superseded` is not here — it needs both signatures, so it cannot race.
 */
export const UNILATERAL_EXITS: readonly string[] = ['closed', 'released', 'expired'] as const;

/** States from which no further assertion is accepted. `disputed` is NOT terminal (§4.3). */
export const TERMINAL_STATES: readonly EffectiveState[] = [
  'closed',
  'released',
  'expired',
  'superseded',
] as const;

/**
 * §4.3 / §6.4: `contested-closure` — two parties each took a legal unilateral exit from `open`,
 * within a window where neither had seen the other's.
 *
 * Found by two honest nodes, with no hostility anywhere: partition them, let the owner close with
 * evidence while the counterparty releases, and each accepts its own act and refuses the other's
 * forever. §6.4's whole guarantee — "both sides see the same chain" — assumes ONE valid chain
 * exists, and here both are valid. Recon then never terminates: each side keeps offering a chain
 * the other keeps discarding, every round, permanently.
 *
 * The three ways out, and why this is the one:
 *
 * - A deterministic tie-break (lowest hash, earliest `asserted_at`) converges immediately and
 *   **silently discards a signed act** — in a protocol built so that a signed act stands. Worse,
 *   `asserted_at` is written by the party it would judge, which §4.3 already had to fix once.
 * - Narrowing §6.4's promise is honest and leaves the debtor's vault reading `closed` forever
 *   while the creditor's reads `released`, with nobody told.
 * - **Naming it converges** — both nodes compute the same state from the same chain — while
 *   discarding nothing. Both assertions stay, both are accepted, and the disagreement becomes
 *   visible to the people who have to settle it. §4.1 already resolves a divergence this way
 *   ("the edge is unverifiable in the sense of M-8"), so this is the precedent, not a new idea.
 *
 * It is M-8 unverifiable: a node MUST NOT auto-escalate on it. And like `disputed`, it is NOT
 * terminal — the exit is mutual: both parties assert `closed`, or both assert `superseded`. A
 * state two people can reach by accident and cannot leave together would be a worse trap than the
 * divergence it replaces.
 */
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
  /**
   * §4.3: `expired` dated further into the verifying node's future than honest clock skew allows.
   * The other half of `expiry-before-due` — `due` cannot be moved unilaterally, and until this
   * existed the claim about *now* could be, which ended an edge for both parties on one signature.
   */
  'expiry-dated-in-the-future',
  'acceptance-window-not-elapsed',
  /** §4.4: `disputed → expired` before `dispute_window` ran. Names a window, never a verdict. */
  'dispute-window-not-elapsed',
  'malformed-edge-acceptance-window',
  /**
   * §4.1: the identifier is not the digest of the body it names. Distinct from
   * `edge-id-mismatch`, which is an assertion pointing at a different edge — here the EDGE
   * is the thing that does not hold together, so no assertion in the chain is valid.
   */
  'edge-id-does-not-bind-body',
  /** v0.2 (§4.3, upstream #38): `asserted_at` is non-decreasing per signer within a chain. */
  'asserted-at-before-signers-previous',
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
