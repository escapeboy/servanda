import { verifyObject } from '@servanda/crypto';
import type { Assertion, AssertionOutcome, Edge, EffectiveState, RejectionReason } from '@servanda/types';
import {
  NON_ASSERTABLE_STATES,
  TERMINAL_STATES,
  collectiveDecompositionValid,
} from '@servanda/types';
import { addDuration } from './duration.js';

/**
 * §4.3 transition table — the heart of the node.
 *
 * §4.3: "Any assertion violating this table is invalid and MUST be discarded by conforming
 * nodes (this is how constitutional rules bind rude clients)." M-14 restates it. A verifier
 * that accepts a `confirmed` assertion signed by the owner has silently discarded the entire
 * confirm-first guarantee while still passing every positive test — which is why the 19
 * negative conformance vectors, not the 7 positive ones, are the real specification here.
 *
 * A rejected assertion is DISCARDED: it never advances the state, and the chain continues to
 * be evaluated against the state as it was.
 *
 * Interpretations taken from vendor/vectors/README.md (not normative spec text, tracked
 * upstream): #3 `confirmed` ≡ `open` and an explicit `open` assertion is rejected; #4 the
 * §4.4 acceptance window is modelled as an internal `pending-acceptance` state; #5 a null
 * `acceptance_window` on an on-acceptance edge means P5D; #6 `disputed → closed` needs both
 * parties; #7 supersession is verified only as "both parties asserted `superseded`", because
 * §4.2's assertion schema has no field able to carry the successor `edge_id`.
 */

/** Source states that count as "the edge is live" — §4.3's `open` row plus its sub-states. */
const OPEN_FAMILY: readonly EffectiveState[] = ['open', 'pending-acceptance'] as const;

export interface ChainVerification {
  outcomes: AssertionOutcome[];
  final_state: EffectiveState;
  /**
   * When the state became terminal, the `asserted_at` of the assertion that took it there.
   * Retention (§5.4) runs its window from this, not from the wall clock.
   */
  resolved_at: string | null;
  /** §4.7 / M-8 / M-9: a collective edge with neither covering children nor a coordinator. */
  unverifiable: boolean;
}

interface ChainState {
  state: EffectiveState;
  /** §4.4: when the owner's evidence assertion opened the acceptance window. */
  window_opened_at: string | null;
  /** §4.5 interpretation #7: which parties have asserted `superseded`. */
  superseded_by: Set<string>;
  /** §4.3 `disputed → closed` requires both parties (interpretation #6). */
  dispute_closed_by: Set<string>;
  /** §4.4: `asserted_at` of the accepted `disputed` assertion — when `dispute_window` starts. */
  disputed_at: string | null;
  resolved_at: string | null;
}

/**
 * §4.7 + M-9 collective decomposition, under this package's own name.
 *
 * The rule lives in `@servanda/types` beside the `Edge` schema it is a property of. This
 * package and `@servanda/adapters` both decide verifiability and neither depends on the other;
 * each used to carry its own byte-identical copy, kept in step by an agreement test.
 */
export { collectiveDecompositionValid as isCollectiveEdgeVerifiable };

function windowElapsed(edge: Edge, openedAt: string, assertedAt: string): boolean {
  // No default. Upstream #5 resolved to the narrow reading: on an `on-acceptance` edge the window
  // is required and non-null, so by the time control reaches here `acceptanceWindowMalformed` has
  // already rejected the alternative. The old `?? DEFAULT_ACCEPTANCE_WINDOW` silently supplied
  // P5D for an edge that never stated one — a term neither party signed.
  const window = edge.acceptance_window as string;
  return Date.parse(assertedAt) >= addDuration(new Date(Date.parse(openedAt)), window).getTime();
}

/**
 * §4.4: `dispute_window` is a protocol CONSTANT, not an edge member.
 *
 * A per-edge value would let one party choose the window that suits them, and the party who
 * benefits from a long freeze is precisely the party who disputes.
 */
export const DISPUTE_WINDOW = 'P30D';

/** Applies one assertion. Returns null on acceptance (mutating `ctx`), or the rejection reason. */
function step(edge: Edge, ctx: ChainState, a: Assertion): RejectionReason | null {
  // The assertion must be about THIS edge before anything else is worth checking.
  if (a.edge_id !== edge.edge_id) return 'edge-id-mismatch';

  // Verify `sig` against the key named in `by`. This — not the presence of a signature — is
  // what stops one party fabricating the counterparty's confirmation.
  if (!verifyObject(a as unknown as Record<string, unknown>, a.by)) return 'invalid-signature';

  // M-3: edges are strictly two-party. A non-party signature is never valid, whatever it says.
  if (a.by !== edge.owner && a.by !== edge.owed_to) return 'signer-not-a-party';

  // §4.3 marks `confirmed → open` "(implicit)" with no authorised signer, so no row permits an
  // explicit `open`. Checked here rather than in the parser: the node must be able to REPORT
  // this reason, which it could not do if the schema had rejected the value (interpretation #3).
  if (NON_ASSERTABLE_STATES.includes(a.state)) return 'implicit-transition-not-assertable';

  // Once terminal, the chain is closed to further assertions. Checked before the table so the
  // reason names the real problem instead of "no such row".
  if (TERMINAL_STATES.includes(ctx.state)) return 'terminal-state-reached';

  const isOwner = a.by === edge.owner;
  const isOwedTo = a.by === edge.owed_to;

  switch (a.state) {
    case 'proposed': {
      if (ctx.state !== 'none') return 'illegal-source-state';
      // M-1: a promise is owned by its giver. "They said they would" is an expectation.
      if (!isOwner) return 'wrong-signer-for-transition';
      ctx.state = 'proposed';
      return null;
    }

    case 'confirmed': {
      if (ctx.state !== 'proposed') return 'illegal-source-state';
      // M-2: the counterparty's signature is what makes the edge exist.
      if (!isOwedTo) return 'wrong-signer-for-transition';
      ctx.state = 'open'; // interpretation #3: confirmed ≡ open
      return null;
    }

    case 'closed': {
      if (ctx.state === 'open') {
        // §4.4: under both policies the owner's assertion is the evidence assertion. Under
        // on-evidence it closes; under on-acceptance it opens the window.
        if (!isOwner) return 'wrong-signer-for-transition';
        if (a.evidence_hash === null) return 'evidence-hash-required-for-owner-closure';
        if (edge.closure_policy === 'on-evidence') {
          ctx.state = 'closed';
          ctx.resolved_at = a.asserted_at;
        } else {
          ctx.state = 'pending-acceptance';
          ctx.window_opened_at = a.asserted_at;
        }
        return null;
      }
      if (ctx.state === 'pending-acceptance') {
        if (isOwedTo) {
          // Explicit accept.
          ctx.state = 'closed';
          ctx.resolved_at = a.asserted_at;
          return null;
        }
        // Owner re-asserting: tacit acceptance, valid only once the window has elapsed.
        if (ctx.window_opened_at === null) return 'illegal-source-state';
        if (!windowElapsed(edge, ctx.window_opened_at, a.asserted_at)) {
          return 'acceptance-window-not-elapsed';
        }
        ctx.state = 'closed';
        ctx.resolved_at = a.asserted_at;
        return null;
      }
      if (ctx.state === 'disputed') {
        // §4.3 `disputed → closed`: both parties (interpretation #6).
        if (ctx.dispute_closed_by.has(a.by)) return 'duplicate-assertion-by-same-party';
        ctx.dispute_closed_by.add(a.by);
        if (ctx.dispute_closed_by.size === 2) {
          ctx.state = 'closed';
          ctx.resolved_at = a.asserted_at;
        }
        return null;
      }
      return 'illegal-source-state';
    }

    case 'released': {
      if (!OPEN_FAMILY.includes(ctx.state)) return 'illegal-source-state';
      // §4.3: unilateral forgiveness by the creditor. An owner releasing themselves would let
      // anyone discharge their own debt.
      if (!isOwedTo) return 'wrong-signer-for-transition';
      ctx.state = 'released';
      ctx.resolved_at = a.asserted_at;
      return null;
    }

    case 'expired': {
      // §4.4: the third exit from `disputed` — it ENDS the edge without resolving it. Both
      // resolutions require both parties, so without this a unilateral dispute freezes an edge
      // permanently against an owner who may have genuinely fulfilled it. It finds for nobody:
      // the dispute and its evidence stay in the chain, and the rejection below names a window,
      // never a verdict.
      if (ctx.state === 'disputed') {
        if (ctx.disputed_at === null) return 'illegal-source-state';
        const windowEnds = addDuration(new Date(Date.parse(ctx.disputed_at)), DISPUTE_WINDOW);
        if (Date.parse(a.asserted_at) < windowEnds.getTime()) {
          return 'dispute-window-not-elapsed';
        }
        ctx.state = 'expired';
        ctx.resolved_at = a.asserted_at;
        return null;
      }
      if (!OPEN_FAMILY.includes(ctx.state)) return 'illegal-source-state';
      // §3.1: undated commitments MUST NOT time-escalate. With no `due` there is no expiry.
      if (edge.due === null) return 'due-is-null';
      if (Date.parse(a.asserted_at) < Date.parse(edge.due)) return 'expiry-before-due';
      // Either party may assert it; both were validated as parties above.
      ctx.state = 'expired';
      ctx.resolved_at = a.asserted_at;
      return null;
    }

    case 'disputed': {
      if (!OPEN_FAMILY.includes(ctx.state)) return 'illegal-source-state';
      if (a.evidence_hash === null) return 'evidence-hash-required';
      ctx.state = 'disputed';
      ctx.disputed_at = a.asserted_at;
      return null;
    }

    case 'superseded': {
      if (!OPEN_FAMILY.includes(ctx.state) && ctx.state !== 'disputed') {
        return 'illegal-source-state';
      }
      // §4.5: both parties of the OLD edge must sign. One party signing twice is not two
      // parties — that substitution is the whole point of the negative vector.
      if (ctx.superseded_by.has(a.by)) return 'duplicate-assertion-by-same-party';
      ctx.superseded_by.add(a.by);
      if (ctx.superseded_by.size === 2) {
        ctx.state = 'superseded';
        ctx.resolved_at = a.asserted_at;
      }
      return null;
    }

    default:
      return 'illegal-source-state';
  }
}

/**
 * Verify a whole assertion chain against an edge.
 *
 * Returns a per-assertion outcome (the vectors' `expected_outcomes`) and the effective state
 * after the chain (`expected_final_state`). Rejected assertions are discarded, never applied.
 */
/**
 * §4.1 — `acceptance_window` MUST be non-null iff `closure_policy` is `on-acceptance`, and there
 * is no default. Both directions are malformed:
 *
 * - a null window on an `on-acceptance` edge would let the owner record tacit acceptance
 *   instantly, which is the exact forgery §4.4 exists to prevent;
 * - a window on any other policy leaves the closure rule and the closure timing disagreeing about
 *   which policy is in force.
 *
 * This is checked here and not in the `Edge` schema on purpose. The parser must keep accepting the
 * shape, because a schema that refused it could not report
 * `malformed-edge-acceptance-window` — the rejection would be indistinguishable from malformed
 * JSON, and the M-14 vector asserting that exact reason could not pass. Same split as
 * `WireAssertionState` admitting `open`: syntax is the parser's job, assertability is the
 * transition table's.
 */
function acceptanceWindowMalformed(edge: Edge): boolean {
  return edge.closure_policy === 'on-acceptance'
    ? edge.acceptance_window == null
    : edge.acceptance_window != null;
}

export function verifyAssertionChain(edge: Edge, assertions: Assertion[]): ChainVerification {
  const ctx: ChainState = {
    state: 'none',
    window_opened_at: null,
    superseded_by: new Set(),
    dispute_closed_by: new Set(),
    disputed_at: null,
    resolved_at: null,
  };

  // A malformed edge accepts no assertions at all — not "the offending one", every one. The edge
  // is the object both parties signed against; if its own closure terms are incoherent there is
  // nothing for an assertion to be valid *about*, so the chain never leaves `none`.
  if (acceptanceWindowMalformed(edge)) {
    return {
      outcomes: assertions.map((_a, index) => ({
        index,
        accepted: false,
        rejection_reason: 'malformed-edge-acceptance-window' as const,
      })),
      final_state: 'none',
      resolved_at: null,
      unverifiable: !collectiveDecompositionValid(edge),
    };
  }

  const outcomes: AssertionOutcome[] = assertions.map((a, index) => {
    const reason = step(edge, ctx, a);
    return reason === null
      ? { index, accepted: true }
      : { index, accepted: false, rejection_reason: reason };
  });

  return {
    outcomes,
    final_state: ctx.state,
    resolved_at: ctx.resolved_at,
    unverifiable: !collectiveDecompositionValid(edge),
  };
}

/** Convenience: the effective state alone. */
export function effectiveState(edge: Edge, assertions: Assertion[]): EffectiveState {
  return verifyAssertionChain(edge, assertions).final_state;
}
