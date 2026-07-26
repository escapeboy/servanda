import type { EvidenceRef } from '@servanda/types';
import type { VerificationAdapter } from './adapter.js';
import type { AdapterName } from './bundle.js';
import { ciAdapter } from './classes/ci.js';
import { gitAdapter } from './classes/git.js';
import { fileAdapter } from './classes/file.js';

/**
 * The v1 registry: hardcoded, three adapters, no plugin mechanism — the same shape, and the same
 * reason, as the executor registry in `@servanda/executors`. There is no `register()`, no
 * discovery, no config file naming an adapter. Adding a fourth means editing this file and
 * passing review.
 *
 * The stake is higher here than for executors. An executor proposes a diff a human then reads;
 * an adapter produces the hash an owner cites when they say a promise was kept, and that hash is
 * what the counterparty's node checks years later. A registry that could be extended at runtime
 * would be a registry in which "verified" means whatever the last plugin decided.
 */

const ADAPTERS: readonly VerificationAdapter[] = Object.freeze([
  ciAdapter,
  gitAdapter,
  fileAdapter,
] as VerificationAdapter[]);

export const REGISTRY: readonly VerificationAdapter[] = ADAPTERS;

/**
 * The adapter that speaks to a ref kind, or `undefined`.
 *
 * `undefined` is the M-8 "no adapter" case and is returned, never thrown: an edge nothing can
 * verify is an ordinary condition of the world, not an error in the program. `url` deliberately
 * has no adapter — observing one needs the network.
 */
export function adapterFor(kind: EvidenceRef['kind']): VerificationAdapter | undefined {
  return ADAPTERS.find((a) => a.declares.includes(kind));
}

export function getAdapter(name: AdapterName): VerificationAdapter {
  const found = ADAPTERS.find((a) => a.name === name);
  if (found === undefined) {
    throw new Error(
      `no verification adapter ${JSON.stringify(name)}; the v1 registry is exactly ` +
        `[${ADAPTERS.map((a) => a.name).join(', ')}] and is not extensible at runtime`,
    );
  }
  return found;
}

/** Which §3.1 evidence-ref kinds any adapter can speak to at all. */
export const OBSERVABLE_REF_KINDS: readonly EvidenceRef['kind'][] = Object.freeze(
  ADAPTERS.flatMap((a) => [...a.declares]),
);
