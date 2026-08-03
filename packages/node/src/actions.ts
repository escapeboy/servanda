import { ACT_TOOL_BINDINGS, type Act, type EffectiveState, type ItemAction } from '@servanda/types';

/**
 * §7 / M-20 — which affordances a node may advertise for one item, to one viewer.
 *
 * Two rules, and the second is the one that was missing:
 *
 *  1. Never advertise an act the §4.3 table would not let this persona sign from this state. An
 *     advertised act that cannot be signed is a button that does nothing.
 *  2. Never bind an advertised act to a tool call that produces no assertion. `tool: null` says
 *     "this affordance is real and v0 signs nothing for it" — honest. Pointing it at a tool that
 *     silently no-ops would tell a person they had acted when they had not.
 *
 * `windowElapsed` is a parameter, never a clock read here. Generation must be deterministic for
 * the same reason envelopes are: the caller supplies the instant, so the same inputs give the same
 * output in a test, in a vector replay, and on a machine in another timezone.
 *
 * Kept as a pure function rather than a method so the eleven `actions.json` vectors can be
 * replayed against it directly, with no vault and no clock in the way.
 */
export type ViewerRole = 'owner' | 'owed_to' | 'non-party';

function bind(act: Act, args: Record<string, unknown> = {}): ItemAction {
  return { act, tool: ACT_TOOL_BINDINGS[act], args };
}

export function actionsFor(input: {
  state: EffectiveState;
  role: ViewerRole;
  edgeId: string;
  windowElapsed: boolean;
  /**
   * §4.4: whether `dispute_window` has run from the deadlock. A separate flag from
   * `windowElapsed`, which is the ACCEPTANCE window — two different windows, on two different
   * states, and collapsing them would advertise the escape from a deadlock at the moment the
   * deadlock began.
   *
   * Defaulted to false so a caller who does not know cannot accidentally offer an act the table
   * would refuse: the safe direction is to withhold an escape briefly, never to advertise one
   * that does not yet exist.
   */
  disputeWindowElapsed?: boolean;
  /**
   * §4.3's first `expired` row: `open → expired`, "either party after `due`". True when the edge
   * has a `due` and it has passed.
   *
   * A third flag rather than a reuse of either above, for the reason those two are separate from
   * each other: three different clocks, on three different states, and collapsing any pair of them
   * advertises an act at a moment the table refuses it.
   */
  dueElapsed?: boolean;
}): ItemAction[] {
  const { state, role, edgeId, windowElapsed } = input;
  const disputeWindowElapsed = input.disputeWindowElapsed ?? false;
  /**
   * §7's `actions.json` cases `open-owner` and `open-owed-to` list `expire` under
   * `must_not_advertise` and carry NO `due_elapsed` input — vector generation is clockless, so
   * the family has no way to express "the due date has passed" and therefore pins this branch and
   * only this branch. The oracle is complied with exactly; what it does not reach, it does not
   * decide. Named rather than written inline so the gap survives being read again: a vector family
   * that cannot state an input cannot forbid the behaviour that input turns on, and treating its
   * silence as a prohibition is how `expire` came to exist in §4.3 and nowhere a person stands.
   */
  const DUE_ELAPSED_UNKNOWN_MEANS_NOT_YET = false;
  const dueElapsed = input.dueElapsed ?? DUE_ELAPSED_UNKNOWN_MEANS_NOT_YET;

  // A non-party is offered nothing at all, in any state. M-4: visibility follows participation.
  if (role === 'non-party') return [];

  switch (state) {
    case 'proposed':
      // §4.3 gives the owner no transition out of `proposed` — they can only wait, so `ping` is
      // the sole affordance, and it signs nothing.
      return role === 'owner'
        ? [bind('ping')]
        : [
            bind('confirm', { id: edgeId, decision: 'confirm' }),
            bind('dismiss', { id: edgeId, decision: 'dismiss' }),
          ];

    case 'open': {
      // §4.3 gives `open` a THIRD unilateral exit — `expired`, either party, once `due` has passed
      // — and §7 advertised it nowhere. So an edge whose due date went by a year ago offered its
      // owner `done`, `supersede` and `delegate`, none of which end it, and offered the party owed
      // `release`, which is forgiveness and therefore a verdict. The one act that ends such an edge
      // deciding nothing was in the table, was signable through `act`, and was invisible.
      //
      // That is the defect `expire` was added to fix at `disputed` and `contested-closure`, one
      // state further along, and it is the older half of it: those two states are reached by a
      // disagreement, this one is reached by a date passing, which happens to every dated promise
      // nobody got to.
      //
      // Not role-gated, on §4.3's own words and for §4.4's reason: an expiry finds for nobody, and
      // both parties are equally stuck with a promise whose moment has gone.
      const expire = dueElapsed ? [bind('expire', { id: edgeId, act: 'expire' })] : [];
      // §7's order is most-consequential-first: `done` · `release` · `expire` · … `expire` ends the
      // promise and signs, which puts it above `supersede` and `delegate`; `done` and `release` end
      // it too and are the acts that say what happened, which puts them above `expire`. §7 notes
      // that this last comparison "is stated here and exercised by no case, because on the current
      // rules no state advertises it alongside either". This state does.
      return role === 'owner'
        ? [bind('done', { id: edgeId, act: 'done' }), ...expire, bind('supersede'), bind('delegate')]
        : [bind('release', { id: edgeId, act: 'release' }), ...expire, bind('ping'), bind('supersede')];
    }

    case 'pending-acceptance':
      // NOT `release`. §4.3 gives `pending-acceptance` three rows and `released` is not among
      // them, so M-20 forbids offering it — and `release` is tool-bound, so the gate reaches it.
      //
      // §4.4's `contested-closure` does accept a `released` here, but only one dated at or before
      // the owner's evidence assertion: a CONCURRENT act, made without sight of it. Anything a
      // client signs now is dated now, which is later, which is refused. Advertising it would tell
      // the counterparty they may forgive a debt and then discard the assertion — the exact
      // failure M-20 exists to prevent.
      //
      // What §4.3 gives them here, explicit acceptance and dispute, has no act in §7's closed
      // vocabulary, so there is nothing tool-bound to offer. §7 now names that gap.
      if (role === 'owed_to') return [bind('supersede')];
      // The owner may record tacit acceptance only once the window has run. Before that, offering
      // `done` would advertise the exact forgery §4.4 exists to prevent.
      return windowElapsed
        ? [bind('done', { id: edgeId, act: 'done' }), bind('supersede'), bind('delegate')]
        : [bind('supersede'), bind('delegate')];

    case 'disputed':
    case 'contested-closure': {
      // Neither party can close a dispute alone (§4.3 requires both), so nothing that asserts is
      // offered. Superseding is the way out that does not pretend the disagreement resolved.
      //
      // `contested-closure` has the identical shape and was falling through to `default` — read
      // as terminal, so a state with THREE legal exits advertised none, and the person who
      // reached it had nothing to press. It is not terminal: §4.4 gives it `closed` by both,
      // `superseded` by both, and `expired` by either once the window has run.
      //
      // It gets `disputed`'s answer and not a richer one, for the reason §7/#41 already settled
      // for `disputed`: the two joint exits need BOTH halves, and `act` binds `done` to the owner
      // alone (`wrong-role-for-act`), so the counterparty has no advertised way to sign theirs.
      // Offering the owner `done` here would record a closure, honestly, that can never complete
      // — the person is told their promise is closed and the edge stays contested for ever. That
      // is the failure M-20 exists to prevent, and advertising an exit is not the same as having
      // one.
      //
      // `expire` IS advertised, to either party, once the window has run. §4.4 argues that this
      // exit is not optional — "a state two people can enter by accident and cannot leave alone
      // is a worse trap than the divergence it replaces" — and it was reachable in the
      // transition table and through no tool at all, which is the same shape §1.7 rotation had:
      // a recovery path that existed everywhere except where a person stands.
      // §7's normative order is most-consequential-first, and `expire` wins both clauses: it
      // ENDS the promise (`expired` is terminal) and it SIGNS (bound to `act`). `supersede` does
      // neither — `tool: null`, and it proposes. Emitted the other way round when it was added,
      // which is exactly the "new act appended rather than placed by the rule" the ordering
      // paragraph was written to stop.
      return disputeWindowElapsed
        ? [bind('expire', { id: edgeId, act: 'expire' }), bind('supersede')]
        : [bind('supersede')];
    }

    default:
      // Terminal: closed, released, expired, superseded. Nothing to offer, to anyone.
      return [];
  }
}
