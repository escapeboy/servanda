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
import { buildBrief, buildInbox, buildLedger } from './view.js';
import type { OpenLoopsOutput } from '@servanda/types';

export interface LoadAppOptions {
  readonly surface: SurfaceId;
  readonly now: string;
  readonly persona?: string | null;
  readonly pending?: OpenLoopsOutput;
  /**
   * The three surfaces that are not built from the five tools. A team surface is built from
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
 * The whole surface, assembled from the five tools and nothing else.
 *
 * `now` is a parameter. A register that renders differently depending on when you look at
 * it cannot be tested, and a morning email composed by a scheduler needs the same view the
 * app would have shown at that instant.
 */
export async function loadApp(client: NodeClient, options: LoadAppOptions): Promise<AppView> {
  const persona = options.persona ?? null;
  const [brief, loops] = await Promise.all([
    client.brief({ persona }),
    client.open_loops({ view: 'all', persona, limit: 500 }),
  ]);
  const proof = options.proof ?? null;
  return {
    surface: options.surface,
    brief: buildBrief(brief, loops, options.now),
    ledger: buildLedger(loops, options.now),
    inbox: buildInbox(options.pending ?? { items: [] }, options.now),
    team: buildTeam(options.team ?? NO_TEAM, options.now),
    integrations: buildIntegrations(options.integrations ?? {}),
    onboarding: buildOnboarding(options.onboarding ?? {}),
    proof: proof === null ? null : buildProof(proof),
  };
}

/** `mount` is browser-only and is imported directly, so this module stays environment-free. */
export type { MountOptions } from './mount.js';
