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
}): ItemAction[] {
  const { state, role, edgeId, windowElapsed } = input;

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

    case 'open':
      return role === 'owner'
        ? [bind('done', { id: edgeId, act: 'done' }), bind('supersede'), bind('delegate')]
        : [bind('release', { id: edgeId, act: 'release' }), bind('ping'), bind('supersede')];

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
      // Neither party can close a dispute alone (§4.3 requires both), so nothing that asserts is
      // offered. Superseding is the way out that does not pretend the disagreement resolved.
      return [bind('supersede')];

    default:
      // Terminal: closed, released, expired, superseded. Nothing to offer, to anyone.
      return [];
  }
}
