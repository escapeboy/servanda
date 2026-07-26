export * from './copy.js';
export * from './element.js';
export * from './fixture-node.js';
export * from './keyboard.js';
export * from './node-client.js';
export * from './render.js';
export * from './seal.js';
export * from './stops.js';
export * from './theme.js';
export * from './view.js';
export * from './vocabulary.js';

import type { NodeClient } from './node-client.js';
import type { AppView, SurfaceId } from './render.js';
import { buildBrief, buildInbox, buildLedger } from './view.js';
import type { OpenLoopsOutput } from '@servanda/types';

/**
 * The whole surface, assembled from the five tools and nothing else.
 *
 * `now` is a parameter. A register that renders differently depending on when you look at
 * it cannot be tested, and a morning email composed by a scheduler needs the same view the
 * app would have shown at that instant.
 */
export async function loadApp(
  client: NodeClient,
  options: { surface: SurfaceId; now: string; persona?: string | null; pending?: OpenLoopsOutput },
): Promise<AppView> {
  const persona = options.persona ?? null;
  const [brief, loops] = await Promise.all([
    client.brief({ persona }),
    client.open_loops({ view: 'all', persona, limit: 500 }),
  ]);
  return {
    surface: options.surface,
    brief: buildBrief(brief, loops, options.now),
    ledger: buildLedger(loops, options.now),
    inbox: buildInbox(options.pending ?? { items: [] }, options.now),
  };
}

/** `mount` is browser-only and is imported directly, so this module stays environment-free. */
export type { MountOptions } from './mount.js';
