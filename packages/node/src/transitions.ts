import { edgeIdBindsBody, verifyObject } from '@servanda/crypto';
import type { Assertion, AssertionOutcome, Edge, EffectiveState, RejectionReason } from '@servanda/types';
import {
  NON_ASSERTABLE_STATES,
  TERMINAL_STATES,
  UNILATERAL_EXITS,
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

/**
 * §4.3 licenses exactly one source-state equivalence: `confirmed` ≡ `open`, so "wherever `open`
 * appears as a source state, an edge whose latest valid assertion is `confirmed` satisfies it".
 * `ctx.state` records that collapse already — accepting `confirmed` sets `open` — so the `open`
 * rows are matched by comparing to `open` and nothing else.
 *
 * `pending-acceptance` is NOT part of that family, and reading it as one was a real over-permit.
 * The table gives it three rows (`closed` by owed_to, `closed` by the owner after the window,
 * `disputed` by either party); sharing a constant with `open` silently added `released`,
 * `expired` and `superseded` to them. The damaging one is `expired`: terminal, unilateral, and
 * available to the creditor the moment `due` passes — so the answer to a debtor's evidence
 * assertion could be to end the edge outright rather than accept or dispute it, which is the
 * §4.4 acceptance window read backwards.
 *
 * Only the `disputed` row spans both, and it says so where it is used rather than through a
 * constant that invites the next transition to join it.
 */
const DISPUTABLE_FROM: readonly EffectiveState[] = ['open', 'pending-acceptance'] as const;

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
  /** The verifying node's own clock, when it has one. Absent for clockless replay. */
  now: number | null;
  state: EffectiveState;
  /** §4.4: when the owner's evidence assertion opened the acceptance window. */
  window_opened_at: string | null;
  /** §4.5 interpretation #7: which parties have asserted `superseded`. */
  superseded_by: Set<string>;
  /** §4.3 `disputed → closed` requires both parties (interpretation #6). */
  dispute_closed_by: Set<string>;
  /**
   * The assertion that took the edge out of `open`, and who signed it.
   *
   * Recorded because `open`'s unilateral exits are mutually exclusive and nothing stops two
   * parties taking different ones concurrently. Without this the second one is refused as
   * `terminal-state-reached` — which is what left two honest nodes permanently divergent.
   */
  exit: { state: EffectiveState; by: string; at: string } | null;
  /** §4.3: both parties must assert to leave `contested-closure`, exactly as with `disputed`. */
  contest_closed_by: Set<string>;
  contest_superseded_by: Set<string>;
  /** §4.4: when the contest was recorded — the instant `dispute_window` runs from. */
  contested_at: string | null;
  /** §4.4: `asserted_at` of the accepted `disputed` assertion — when `dispute_window` starts. */
  disputed_at: string | null;
  /**
   * §4.3 (v0.2, upstream #38): the latest `asserted_at` accepted from each signer.
   *
   * Both windows in the spec are measured between two `asserted_at` values, and both of those
   * were written by the party the window constrains: an owner minting `closed` dated years back
   * and `closed` dated now computed the acceptance window as elapsed on an edge the counterparty
   * had only confirmed. Per-signer rather than global, because two honest parties disagree about
   * `now` and neither is authoritative over the other's clock.
   */
  latest_by_signer: Map<string, string>;
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

/**
 * How far into a node's own future an `expired` assertion may be dated before it is discarded.
 *
 * §4.3 held `expired` up as the SOUND contrast to the self-asserted windows: "`due` sits on the
 * edge object that both parties signed, cannot be moved unilaterally, and so the check on it means
 * something." The check on `due` does mean something. The claim about *now* did not — and one
 * assertion is enough, because the per-signer monotonic rule has nothing earlier by that signer to
 * compare against.
 *
 * The consequence was total: confirm an edge due in 2028, immediately sign `expired` dated 2028,
 * and the counterparty's node records the edge as terminally expired two years early. `expired`
 * is terminal, so the owner can never act on their own commitment again.
 *
 * §4.3 said a node "MAY additionally refuse an assertion dated in its own future; that is local
 * policy, not conformance, because two honest nodes disagree about *now*". That reasoning holds
 * for seconds and minutes. It does not stretch to months, and a MAY over a transition that ends
 * an edge for both parties is not a policy — it is the difference between the rule working and
 * not. One day is far past any honest disagreement between machines whose timestamps carry an
 * offset, and it turns "two years early" into "one day early", which is not an attack worth having.
 */
export const EXPIRY_SKEW_MS = 86_400_000;

/**
 * Would this assertion have been a legal unilateral exit from `open`? Null if yes, otherwise the
 * reason it would have been refused.
 *
 * Separate from the table rather than folded into it, because it answers a counterfactual: the
 * chain is no longer at `open`, and the question is whether this party COULD have acted when they
 * did. Only a legal act contests; an illegal one is not half of a disagreement.
 */
function unilateralExitFault(edge: Edge, a: Assertion, now: number | null): RejectionReason | null {
  const isOwner = a.by === edge.owner;
  const isOwedTo = a.by === edge.owed_to;
  switch (a.state) {
    case 'closed':
      if (!isOwner) return 'wrong-signer-for-transition';
      return a.evidence_hash === null ? 'evidence-hash-required-for-owner-closure' : null;
    case 'released':
      return isOwedTo ? null : 'wrong-signer-for-transition';
    case 'expired':
      if (edge.due === null) return 'due-is-null';
      if (Date.parse(a.asserted_at) < Date.parse(edge.due)) return 'expiry-before-due';
      return now !== null && Date.parse(a.asserted_at) > now + EXPIRY_SKEW_MS
        ? 'expiry-dated-in-the-future'
        : null;
    default:
      return 'illegal-source-state';
  }
}

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

  // §4.3 / §6.4: two parties, two different legal unilateral exits from `open`, taken before
  // either saw the other's. Checked BEFORE the terminal guard, because refusing the second one is
  // exactly what makes two honest nodes diverge permanently — each accepts its own act, discards
  // the other's, and §6.4 can never reach "nothing to send".
  //
  // Both acts stand. The state becomes `contested-closure`, which both sides compute from the
  // same chain, so they converge; and nothing signed is thrown away, which is what a tie-break
  // would have done.
  //
  // **Only a CONCURRENT act contests.** An assertion dated later than the exit it conflicts with
  // could have been a response to it, and §4.3's rows already say what the answer to an exit is:
  // accept it, or dispute it. Without this the creditor's `released` after seeing the owner's
  // evidence would reach `contested-closure` — reversing the `pending-acceptance` restriction
  // decided the same day, and letting a party who waited claim the position of one who did not.
  //
  // The comparison is between two self-written timestamps, which §4.3 rightly distrusts. It is
  // safe here because backdating buys nothing: a counterparty who wants to stop a close already
  // has `disputed`, legal from `pending-acceptance`, with the same blocking effect and an
  // `evidence_hash` attached. There is no position reachable by lying that is not reachable
  // honestly.
  if (
    ctx.exit !== null &&
    a.by !== ctx.exit.by &&
    UNILATERAL_EXITS.includes(a.state) &&
    a.state !== ctx.exit.state &&
    ctx.state !== 'contested-closure' &&
    Date.parse(a.asserted_at) <= Date.parse(ctx.exit.at)
  ) {
    // It only contests if it would have been LEGAL from `open`. An illegal act is not half of a
    // disagreement — it is just illegal, and must still be reported as such.
    const fault = unilateralExitFault(edge, a, ctx.now);
    if (fault !== null) return fault;
    ctx.state = 'contested-closure';
    ctx.contested_at = a.asserted_at;
    ctx.resolved_at = a.asserted_at;
    return null;
  }

  // Once terminal, the chain is closed to further assertions. Checked before the table so the
  // reason names the real problem instead of "no such row".
  if (TERMINAL_STATES.includes(ctx.state)) return 'terminal-state-reached';

  // §4.3: `contested-closure` leaves the same way `disputed` does — both parties, or not at all.
  if (ctx.state === 'contested-closure') {
    const both = (seen: Set<string>): RejectionReason | null => {
      if (seen.has(a.by)) return 'duplicate-assertion-by-same-party';
      seen.add(a.by);
      return null;
    };
    if (a.state === 'closed') {
      const bad = both(ctx.contest_closed_by);
      if (bad) return bad;
      if (ctx.contest_closed_by.size === 2) {
        ctx.state = 'closed';
        ctx.resolved_at = a.asserted_at;
      }
      return null;
    }
    if (a.state === 'superseded') {
      const bad = both(ctx.contest_superseded_by);
      if (bad) return bad;
      if (ctx.contest_superseded_by.size === 2) {
        ctx.state = 'superseded';
        ctx.resolved_at = a.asserted_at;
      }
      return null;
    }
    // §4.4's third exit, and this state needs it for exactly the reason `disputed` does.
    //
    // Both resolutions above require BOTH parties, so without this a contest is a unilateral act
    // that freezes an edge permanently — which is the trap §4.4 already names and already refused
    // to build: "a counterparty who disputes and then goes silent leaves an owner who may have
    // genuinely fulfilled the commitment holding an edge that can never close, never expire and
    // never be superseded."
    //
    // It was worse here than there. `disputed` costs the counterparty an `evidence_hash` and
    // carries this escape; a contest reached by backdating a `released` cost nothing and had no
    // escape at all, so it was a STRICTLY stronger, evidence-free, permanent freeze. The comment
    // above that reasoned "backdating buys nothing, because `disputed` blocks just as firmly" was
    // wrong on both counts, and is true only now that this exit exists.
    //
    // It decides nothing about the merits, exactly as §4.4 says of the `disputed` case: both acts
    // stay in the chain, and the rejection below names a window and never a verdict.
    if (a.state === 'expired') {
      if (ctx.contested_at === null) return 'illegal-source-state';
      const windowEnds = addDuration(new Date(Date.parse(ctx.contested_at)), DISPUTE_WINDOW);
      if (Date.parse(a.asserted_at) < windowEnds.getTime()) return 'dispute-window-not-elapsed';
      if (ctx.now !== null && Date.parse(a.asserted_at) > ctx.now + EXPIRY_SKEW_MS) {
        return 'expiry-dated-in-the-future';
      }
      ctx.state = 'expired';
      ctx.resolved_at = a.asserted_at;
      return null;
    }
    return 'illegal-source-state';
  }

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
        ctx.exit = { state: 'closed', by: a.by, at: a.asserted_at };
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
      if (ctx.state !== 'open') return 'illegal-source-state';
      // §4.3: unilateral forgiveness by the creditor. An owner releasing themselves would let
      // anyone discharge their own debt.
      if (!isOwedTo) return 'wrong-signer-for-transition';
      ctx.exit = { state: 'released', by: a.by, at: a.asserted_at };
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
      if (ctx.state !== 'open') return 'illegal-source-state';
      // §3.1: undated commitments MUST NOT time-escalate. With no `due` there is no expiry.
      if (edge.due === null) return 'due-is-null';
      if (Date.parse(a.asserted_at) < Date.parse(edge.due)) return 'expiry-before-due';
      // The other half of the same question, and the one that was missing: `due` cannot be moved,
      // but the claim about *now* can, and this transition is terminal and needs nobody's consent.
      if (ctx.now !== null && Date.parse(a.asserted_at) > ctx.now + EXPIRY_SKEW_MS) {
        return 'expiry-dated-in-the-future';
      }
      // Either party may assert it; both were validated as parties above.
      ctx.exit = { state: 'expired', by: a.by, at: a.asserted_at };
      ctx.state = 'expired';
      ctx.resolved_at = a.asserted_at;
      return null;
    }

    case 'disputed': {
      if (!DISPUTABLE_FROM.includes(ctx.state)) return 'illegal-source-state';
      if (a.evidence_hash === null) return 'evidence-hash-required';
      ctx.state = 'disputed';
      ctx.disputed_at = a.asserted_at;
      return null;
    }

    case 'superseded': {
      if (ctx.state !== 'open' && ctx.state !== 'disputed') {
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

/**
 * `now` is optional, and its absence is not an oversight. Vector generation and the conformance
 * runner are both clockless on purpose — "an IUT that reads a clock here is answering a different
 * question than the one asked" — so a chain replayed against the suite must reach the same verdict
 * on every machine forever. A node verifying live traffic has a clock and MUST pass it; what that
 * buys is the `expired` bound, which is therefore a prose obligation no vector can carry.
 */
export function verifyAssertionChain(
  edge: Edge,
  assertions: Assertion[],
  now?: string,
): ChainVerification {
  const ctx: ChainState = {
    now: now === undefined ? null : Date.parse(now),
    state: 'none',
    window_opened_at: null,
    superseded_by: new Set(),
    dispute_closed_by: new Set(),
    exit: null,
    contest_closed_by: new Set(),
    contest_superseded_by: new Set(),
    contested_at: null,
    disputed_at: null,
    resolved_at: null,
    latest_by_signer: new Map(),
  };

  // A malformed edge accepts no assertions at all — not "the offending one", every one. The edge
  // is the object both parties signed against; if its own closure terms are incoherent there is
  // nothing for an assertion to be valid *about*, so the chain never leaves `none`.
  //
  // §4.1's binding rule is first, ahead of the closure terms, because it is what makes the rest
  // of the body worth reading: the identifier digests both parties and the commitment, so an
  // unbound edge can satisfy every signer check on its own terms while its chain sits under
  // somebody else's identifier. The vault refuses to store one, so this is the wire-facing half
  // of the same rule rather than a second opinion about it.
  const edgeMalformed = !edgeIdBindsBody(edge)
    ? ('edge-id-does-not-bind-body' as const)
    : acceptanceWindowMalformed(edge)
      ? ('malformed-edge-acceptance-window' as const)
      : null;
  if (edgeMalformed) {
    return {
      outcomes: assertions.map((_a, index) => ({
        index,
        accepted: false,
        rejection_reason: edgeMalformed,
      })),
      final_state: 'none',
      resolved_at: null,
      unverifiable: !collectiveDecompositionValid(edge),
    };
  }

  const outcomes: AssertionOutcome[] = assertions.map((a, index) => {
    // Checked before the table, because a backdated assertion is not a transition error — the
    // transition may be perfectly legal — and reporting it as `illegal-source-state` would name
    // the wrong thing.
    const previous = ctx.latest_by_signer.get(a.by);
    if (previous !== undefined && Date.parse(a.asserted_at) < Date.parse(previous)) {
      return { index, accepted: false, rejection_reason: 'asserted-at-before-signers-previous' as const };
    }
    const reason = step(edge, ctx, a);
    if (reason === null) ctx.latest_by_signer.set(a.by, a.asserted_at);
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
