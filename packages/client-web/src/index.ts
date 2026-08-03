export * from './copy.js';
export * from './element.js';
export * from './fixture-node.js';
export * from './integrations.js';
export * from './keyboard.js';
export * from './node-client.js';
export * from './onboarding.js';
export * from './proof.js';
export * from './render.js';
export * from './seal.js';
export * from './stops.js';
export * from './team.js';
export * from './theme.js';
export * from './view.js';
export * from './vocabulary.js';

import type { IntegrationsInput } from './integrations.js';
import { buildIntegrations } from './integrations.js';
import type { NodeClient } from './node-client.js';
import type { OnboardingInput } from './onboarding.js';
import { buildOnboarding } from './onboarding.js';
import type { ProofRecord } from './proof.js';
import { buildProof } from './proof.js';
import type { AppView, SurfaceId } from './render.js';
import type { TeamInput } from './team.js';
import { NO_TEAM, buildTeam } from './team.js';
import { buildBrief, buildInbox, buildLedger, waitingIdsOf } from './view.js';
import type { OpenLoopsOutput } from '@servanda/types';

export interface LoadAppOptions {
  readonly surface: SurfaceId;
  readonly now: string;
  readonly persona?: string | null;
  readonly pending?: OpenLoopsOutput;
  /**
   * The three surfaces that are not built from the six tools. A team surface is built from
   * what parties chose to share (§5.2); a proof page from one promise's hashes; first run
   * from nothing at all, because there is nothing yet. Each is absent by default, and
   * absent means empty rather than fabricated.
   */
  readonly team?: TeamInput;
  readonly proof?: ProofRecord | null;
  readonly integrations?: IntegrationsInput;
  readonly onboarding?: OnboardingInput;
}

/**
 * The whole surface, assembled from the six tools and nothing else.
 *
 * `now` is a parameter. A register that renders differently depending on when you look at
 * it cannot be tested, and a morning email composed by a scheduler needs the same view the
 * app would have shown at that instant.
 */
export async function loadApp(client: NodeClient, options: LoadAppOptions): Promise<AppView> {
  const persona = options.persona ?? null;
  // Four reads, not one. `view: 'all'` is the brief's index — it must reach every item a slot can
  // name — but it flattens away WHICH SIDE of each promise the viewer is on, and the ledger is
  // built on exactly that distinction. §7 already defines the three views; asking for them is how
  // the role survives the trip. Re-deriving it from `kind` put a promise made TO you under
  // "You owe" for the whole of v0.
  const [brief, loops, owe, waiting, closed] = await Promise.all([
    client.brief({ persona }),
    client.open_loops({ view: 'all', persona, limit: 500, cursor: null }),
    client.open_loops({ view: 'owe', persona, limit: 500, cursor: null }),
    client.open_loops({ view: 'waiting', persona, limit: 500, cursor: null }),
    client.open_loops({ view: 'closed', persona, limit: 500, cursor: null }),
  ]);
  const buckets = { owe, waiting, closed };
  const proof = options.proof ?? null;
  return {
    surface: options.surface,
    brief: buildBrief(brief, loops, options.now, waitingIdsOf(buckets)),
    ledger: buildLedger(buckets, options.now),
    inbox: buildInbox(options.pending ?? { items: [], total: 0, next_cursor: null, skipped: 0 }, options.now),
    team: buildTeam(options.team ?? NO_TEAM, options.now),
    integrations: buildIntegrations(options.integrations ?? {}),
    onboarding: buildOnboarding(options.onboarding ?? {}),
    proof: proof === null ? null : buildProof(proof),
  };
}

/** `mount` is browser-only and is imported directly, so this module stays environment-free. */
export type { MountOptions } from './mount.js';
