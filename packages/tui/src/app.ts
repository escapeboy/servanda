import type { AppView, NodeClient, Stop, SurfaceId } from '@servanda/client-web';
import { SURFACES, stopsFor } from '@servanda/client-web';

/**
 * The terminal's interaction model, as a pure function of state and a key.
 *
 * Every action is reachable by keys alone here for the same reason it is in the browser:
 * there is no other way to reach anything. The parity that matters is that the cursor walks
 * exactly `stopsFor(app)` — the same list the browser's Tab order walks.
 */

export interface TuiState {
  readonly app: AppView;
  readonly cursor: number;
  readonly quit: boolean;
}

export interface KeyResult {
  readonly state: TuiState;
  /** The action id the key activated, if any. */
  readonly activated: string | null;
  /** The surface the key asked for, if any. */
  readonly surface: SurfaceId | null;
}

/** Ctrl-C, written by code point so no control character sits literally in the source. */
const INTERRUPT = String.fromCharCode(3);
const ACTIVATION = new Set(['\r', '\n', ' ']);
const FORWARD = new Set(['\t', 'j', '[B']);
const BACKWARD = new Set(['[Z', 'k', '[A']);

export function handleKey(state: TuiState, key: string): KeyResult {
  const stops: Stop[] = stopsFor(state.app);

  if (key === 'q' || key === INTERRUPT) {
    return { state: { ...state, quit: true }, activated: null, surface: null };
  }

  const digit = Number.parseInt(key, 10);
  if (Number.isInteger(digit) && digit >= 1 && digit <= SURFACES.length) {
    const surface = SURFACES[digit - 1];
    if (surface !== undefined) {
      return { state: { ...state, cursor: digit - 1 }, activated: null, surface: surface.id };
    }
  }

  if (FORWARD.has(key)) {
    const cursor = stops.length === 0 ? 0 : (state.cursor + 1) % stops.length;
    return { state: { ...state, cursor }, activated: null, surface: null };
  }

  if (BACKWARD.has(key)) {
    const cursor = stops.length === 0 ? 0 : (state.cursor - 1 + stops.length) % stops.length;
    return { state: { ...state, cursor }, activated: null, surface: null };
  }

  if (ACTIVATION.has(key)) {
    const stop = stops[state.cursor];
    if (stop === undefined) return { state, activated: null, surface: null };
    if (stop.kind === 'surface') {
      return { state, activated: null, surface: stop.id as SurfaceId };
    }
    return { state, activated: stop.id, surface: null };
  }

  return { state, activated: null, surface: null };
}

/**
 * Confirming from the terminal goes through §7's `confirm`, the same tool the browser uses.
 * Actions §7 has no tool for are returned to the caller rather than guessed at.
 */
export async function dispatch(
  client: NodeClient,
  app: AppView,
  actionId: string,
): Promise<'confirmed' | 'dismissed' | 'revised' | 'unmapped'> {
  const cards = [
    ...app.brief.cards,
    ...app.inbox.cards,
    ...app.ledger.sections.flatMap((s) => s.cards),
  ];
  const action = cards.flatMap((c) => c.actions).find((a) => a.id === actionId);
  if (action === undefined || action.dispatch.kind !== 'tool') return 'unmapped';
  const args = action.dispatch.args as { id: string; decision: 'confirm' | 'dismiss' };
  const result = await client.confirm({ id: args.id, decision: args.decision });
  return result.state;
}
