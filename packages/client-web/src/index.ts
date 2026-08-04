export * from './copy.js';
export * from './element.js';
export * from './fixture-node.js';
export * from './integrations.js';
export * from './keyboard.js';
export * from './node-client.js';
export * from './onboarding.js';
export * from './paging.js';
export * from './warnings.js';
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
import { asOutput, walkView } from './paging.js';
import type { DeliveryInput, VaultStrengthInput } from './warnings.js';
import { buildDelivery, buildVaultStrength } from './warnings.js';
import type { TeamInput } from './team.js';
import { NO_TEAM, buildTeam } from './team.js';
import { buildBrief, buildInbox, buildLedger, buildReach, waitingIdsOf } from './view.js';
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
  /**
   * Two things the node knows that no client could reach.
   *
   * `@servanda/client-web` depends on `@servanda/types` and nothing else — a browser package
   * cannot carry a KDF or a git transport — so an embedder maps `Vault.kdfProfile()` and
   * `FederatedNode.outbound()` onto these. FACTS only: `OutboundStatus` composes an
   * `explanation` sentence of its own, and rendering that would be node-authored copy crossing
   * into a client, which M-21 forbids and gate GE scans for.
   */
  readonly vault?: VaultStrengthInput;
  readonly delivery?: DeliveryInput;
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
  // Separate reads per view, not one. `view: 'all'` is the brief's index — it must reach every
  // item a slot can name — but it flattens away WHICH SIDE of each promise the viewer is on, and
  // the ledger is built on exactly that distinction. §7 already defines the views; asking for
  // them is how the role survives the trip. Re-deriving it from `kind` put a promise made TO you
  // under "You owe" for the whole of v0.
  //
  // Each view is WALKED, not sampled. `limit` is capped at 500, so a single read of a register
  // holding more than that showed a prefix and called it the register — and `total`, added to the
  // node to make that visible, had no reader in any client. See `walkView`.
  const [brief, allWalk, oweWalk, waitingWalk, closedWalk, pendingWalk] = await Promise.all([
    client.brief({ persona }),
    walkView(client, 'all', persona),
    walkView(client, 'owe', persona),
    walkView(client, 'waiting', persona),
    walkView(client, 'closed', persona),
    // Fetched rather than injected. `options.pending` stayed an input with an EMPTY default, so
    // a caller who did not know to pass it got a silently empty inbox — and after §3 ingestion
    // landed, that is where every extracted candidate and every inbound proposal now arrives.
    // The parameter survives as an override for the email brief, which composes from a snapshot.
    options.pending === undefined ? walkView(client, 'pending', persona) : null,
  ]);
  const loops = asOutput(allWalk);
  const buckets = { owe: asOutput(oweWalk), waiting: asOutput(waitingWalk), closed: asOutput(closedWalk) };
  const pending = options.pending ?? asOutput(pendingWalk!);
  const proof = options.proof ?? null;
  return {
    surface: options.surface,
    vault: buildVaultStrength(options.vault),
    delivery: buildDelivery(options.delivery),
    reach: buildReach([allWalk, oweWalk, waitingWalk, closedWalk, ...(pendingWalk ? [pendingWalk] : [])]),
    brief: buildBrief(brief, loops, options.now, waitingIdsOf(buckets)),
    ledger: buildLedger(buckets, options.now),
    inbox: buildInbox(pending, options.now),
    team: buildTeam(options.team ?? NO_TEAM, options.now),
    integrations: buildIntegrations(options.integrations ?? {}),
    onboarding: buildOnboarding(options.onboarding ?? {}),
    proof: proof === null ? null : buildProof(proof),
  };
}

/** `mount` is browser-only and is imported directly, so this module stays environment-free. */
export type { MountOptions } from './mount.js';
