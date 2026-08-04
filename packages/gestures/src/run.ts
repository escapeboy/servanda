import type { NodeClient } from '@servanda/client-web';
import type { GestureIntent } from './intent.js';

/**
 * What a gesture DOES, as opposed to what it says.
 *
 * The package built cards and the intents behind them, and nothing anywhere executed one:
 * `grep` for `GestureIntent` outside this package found nothing at all. So a card could be
 * rendered, tapped, and its answer went nowhere. Every test passed, because every test asserted
 * the intent was correctly SHAPED.
 *
 * A gesture may name a §7 tool and nothing else — that rule lives in `intent.ts` and this is
 * where it is enforced at the moment of action. `UnmappedIntent` is refused rather than
 * approximated: §7 advertises five actions on an item and binds a tool to none of them
 * (upstream #19), and improvising one would mean a client calling a tool no conforming node has
 * to implement.
 *
 * The client is the interface, never an implementation — same as `GesturePoster` and
 * `PersonaDirectory`. A gesture surface that opened a connection would be one that could be
 * made to open one by the message it arrived with, and gate GL proves this package never does.
 */

export type GestureOutcome =
  | { readonly ran: true; readonly tool: 'confirm'; readonly state: string }
  | { readonly ran: true; readonly tool: 'commit'; readonly edgeId: string | null }
  | { readonly ran: true; readonly tool: 'expect'; readonly expectationId: string }
  /**
   * Nothing was called, and why.
   *
   * A refusal carries the reason the intent itself gave, so the sentence a person eventually
   * sees comes from the place that knows what is missing rather than from a catch-all here.
   */
  | { readonly ran: false; readonly because: string };

export async function runIntent(
  intent: GestureIntent,
  client: NodeClient,
): Promise<GestureOutcome> {
  if (intent.kind === 'unmapped') {
    return { ran: false, because: intent.because };
  }
  switch (intent.tool) {
    case 'confirm': {
      const out = await client.confirm(intent.args);
      return { ran: true, tool: 'confirm', state: out.state };
    }
    case 'commit': {
      const out = await client.commit(intent.args);
      return { ran: true, tool: 'commit', edgeId: out.edge_id };
    }
    case 'expect': {
      const out = await client.expect(intent.args);
      return { ran: true, tool: 'expect', expectationId: out.expectation_id };
    }
  }
}
