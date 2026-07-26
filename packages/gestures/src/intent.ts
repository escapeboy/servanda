import type { CommitInput, ConfirmInput, ExpectInput, OpenLoopAction } from '@servanda/types';
import type { PlaceId } from './copy.js';
import type { OwnUtterance, Utterance } from './utterance.js';

/**
 * What a gesture is allowed to emit.
 *
 * The rule is short: a gesture may name a §7 tool and nothing else. It does not invent
 * verbs, it does not reach past the node surface, and where the surface offers no tool it
 * says so rather than improvising one.
 *
 * §7's `open_loops` advertises five actions — done, release, supersede, delegate, ping — and
 * names a tool for none of them. `confirm` covers accept, dismiss and revise; the other four
 * have no tool at all. This is upstream issue #19. Papering over it would mean shipping a
 * client that calls a tool no conforming node has to implement, so instead a gesture that
 * would take one of those actions produces `UnmappedIntent`: typed, inert, and visible.
 * `@servanda/client-web` reaches the same conclusion in `dispatchFor`; this is the same
 * decision taken twice rather than two different decisions.
 */

/**
 * ADR-0012: every decision is a label. A dismissal is the most valuable of them — it is the
 * only signal that says an extraction was wrong — so it is carried, not dropped. Content
 * never appears here; a label is a decision, a place and a moment.
 */
export interface FlywheelLabel {
  readonly decision: 'confirm' | 'dismiss' | 'edit';
  readonly place: PlaceId;
  readonly item: string;
  readonly at: string;
}

export interface ConfirmIntent {
  readonly kind: 'tool';
  readonly tool: 'confirm';
  readonly args: ConfirmInput;
  readonly flywheel: FlywheelLabel;
}

export interface CommitIntent {
  readonly kind: 'tool';
  readonly tool: 'commit';
  readonly args: CommitInput;
}

export interface ExpectIntent {
  readonly kind: 'tool';
  readonly tool: 'expect';
  readonly args: ExpectInput;
}

export interface UnmappedIntent {
  readonly kind: 'unmapped';
  readonly action: OpenLoopAction;
  readonly because: string;
}

export type GestureIntent = ConfirmIntent | CommitIntent | ExpectIntent | UnmappedIntent;

/** The four §7 actions that no §7 tool implements (issue #19). */
export const UNMAPPED_ACTIONS: readonly OpenLoopAction[] = ['done', 'release', 'delegate', 'ping'];

export const UNMAPPED_REASON =
  'open_loops advertises this action and the node surface names no tool for it';

export function unmappedIntent(action: OpenLoopAction): UnmappedIntent {
  return { kind: 'unmapped', action, because: UNMAPPED_REASON };
}

/**
 * Accepting a pending extraction. Takes `OwnUtterance`, so there is no way to call it about
 * a promise somebody else made (M-1).
 */
export function confirmIntent(utterance: OwnUtterance, pendingId: string): ConfirmIntent {
  return {
    kind: 'tool',
    tool: 'confirm',
    args: { id: pendingId, decision: 'confirm' },
    flywheel: {
      decision: 'confirm',
      place: utterance.place,
      item: pendingId,
      at: utterance.occurredAt,
    },
  };
}

/**
 * Throwing a pending extraction away. Available on anybody's words, because the queue item
 * being dismissed is the confirming person's own — dismissing a wrong reading of what
 * somebody else said asserts nothing about them.
 */
export function dismissIntent(utterance: Utterance, pendingId: string): ConfirmIntent {
  return {
    kind: 'tool',
    tool: 'confirm',
    args: { id: pendingId, decision: 'dismiss' },
    flywheel: {
      decision: 'dismiss',
      place: utterance.place,
      item: pendingId,
      at: utterance.occurredAt,
    },
  };
}

/**
 * Level 0 capture: an explicit gesture on your own words, with nothing pending behind them.
 *
 * `persona` is fixed at null — the active persona — and is never taken from a payload. §7
 * says a `commit` whose owner is not the caller's own is invalid; the way to make that
 * unreachable is to give the payload no way to name one.
 */
export function commitIntent(utterance: OwnUtterance): CommitIntent {
  return {
    kind: 'tool',
    tool: 'commit',
    args: {
      intent: utterance.text,
      owed_to: utterance.owedTo?.personaId ?? null,
      due: null,
      persona: null,
      propose: utterance.owedTo?.personaId != null,
    },
  };
}

/**
 * The correct object for "they said they would" (§3.3, §3.4, M-1). Local, never on the wire,
 * and held by the person who made the gesture rather than asserted about the person who
 * spoke.
 */
export function expectIntent(utterance: Utterance): ExpectIntent {
  return {
    kind: 'tool',
    tool: 'expect',
    args: {
      expect: utterance.text,
      from: utterance.speaker.personaId ?? utterance.speaker.display,
      context: utterance.ref.value,
    },
  };
}
