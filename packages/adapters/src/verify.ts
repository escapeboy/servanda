import { PROTOCOL_VERSION } from '@servanda/types';
import type { Edge, EvidenceRef } from '@servanda/types';
import type {
  AdapterCommitment,
  NotVerifiableReason,
  ObservationContext,
  VerificationOutcome,
} from './adapter.js';
import { notVerifiable, observed } from './adapter.js';
import type { AdapterName, Observation } from './bundle.js';
import { collectiveDecompositionValid } from './collective.js';
import { adapterFor } from './registry.js';

/**
 * Verify a commitment: run its §3.1 `evidence_refs` past the registry and return either one
 * evidence bundle or `NotVerifiable`.
 *
 * Three readings are taken here, all of them the narrowest available, all of them reported:
 *
 *  1. **A ref no adapter can speak to is skipped, not fatal.** `@servanda/connectors-github`
 *     emits an html `url` ref alongside every `commit` ref; treating one unobservable ref as
 *     poisoning the whole commitment would make virtually every real commitment unverifiable,
 *     which cannot be what M-8 means. So: at least one ref must be observed, and the ones that
 *     were observed must all hold.
 *  2. **All observed refs must be satisfied**, not any. `evidence_refs` is the evidence *for*
 *     one promise; a node that closed on the one ref that held while another said the file was
 *     never written would be manufacturing consent.
 *  3. **A `satisfied: false` bundle is still a bundle.** "CI ran and failed" is an observation.
 *     Only "I could not look" is `NotVerifiable`. Conflating the two would let a node report a
 *     broken promise as an unverifiable one, which M-8 then quietly excuses from escalation.
 */
export function verifyCommitment(
  commitment: AdapterCommitment,
  context: ObservationContext,
): VerificationOutcome {
  // §4.7 / M-9 first: a collective edge without a decomposition or a coordinator is unverifiable
  // whatever its evidence says, because there is no way to know whose fulfillment it names.
  if (context.edge !== undefined && !collectiveDecompositionValid(context.edge)) {
    return notVerifiable(
      'collective-without-decomposition-or-coordinator',
      `collective edge ${context.edge.edge_id} has neither covering children nor a coordinator`,
    );
  }

  const refs: readonly EvidenceRef[] = commitment.evidence_refs;
  if (refs.length === 0) {
    return notVerifiable('no-evidence-refs', 'the commitment names no evidence to observe');
  }

  const adapters = new Set<AdapterName>();
  const observations: Observation[] = [];
  let satisfied = true;
  let firstFailure: { reason: NotVerifiableReason; detail: string } | null = null;

  for (const ref of refs) {
    const adapter = adapterFor(ref.kind);
    // Reading 1: a kind nothing speaks to is skipped here and only becomes decisive below, if
    // nothing at all was observed.
    if (adapter === undefined) continue;
    const outcome = adapter.observe(commitment, ref, context);
    if (!outcome.verifiable) {
      firstFailure ??= { reason: outcome.reason, detail: outcome.detail };
      continue;
    }
    adapters.add(adapter.name);
    observations.push(...outcome.bundle.observations);
    satisfied &&= outcome.bundle.satisfied;
  }

  if (observations.length === 0) {
    if (firstFailure !== null) return notVerifiable(firstFailure.reason, firstFailure.detail);
    const kinds = refs.map((r) => r.kind);
    const onlyUrls = kinds.every((k) => k === 'url');
    return notVerifiable(
      onlyUrls ? 'requires-network' : 'no-adapter-for-evidence',
      onlyUrls
        ? 'the only evidence named is a url, and observing one needs the network'
        : `no adapter speaks to [${kinds.join(', ')}]`,
    );
  }

  return observed({
    v: PROTOCOL_VERSION,
    type: 'evidence_bundle',
    // Sorted here so the merged bundle satisfies the schema's ordering rule and hashes the same
    // whichever order the refs happened to arrive in.
    adapters: [...adapters].sort(),
    commitment_hash: commitment.commitment_hash,
    observed_at: context.now,
    satisfied,
    observations,
  });
}

/**
 * M-8: "Unverifiable edges (no adapter, or invalid collective) MUST NOT auto-escalate."
 *
 * INTERPRETATION, and the load-bearing one in this package. "Unverifiable" names a property of
 * the edge with two causes, and only the second is unconditional:
 *
 *  - **invalid collective** (§4.7, M-9) — unverifiable always, whatever the closure policy.
 *  - **no adapter** — unverifiable *for an `on-evidence` edge*, because §4.4 says such an edge
 *    closes only on "a `closed` assertion by the owner with non-null `evidence_hash` (hash of
 *    the verification adapter's evidence bundle)". No adapter, no bundle, no hash, no closure:
 *    the edge is structurally unclosable and the node has no business escalating it at a human.
 *
 * An `on-acceptance` edge is NOT caught by the second bar. It closes on the counterparty's act
 * or on window expiry, not on evidence, so "no adapter" says nothing about it — and §4.4 makes
 * on-acceptance the default for cross-person edges. The wider reading (any edge lacking an
 * adapter never escalates) would silence scenario 4 entirely: nobody would ever be reminded of
 * a promise to another person, which is the product. `test/musts/M-08.test.ts` pins both halves.
 */
export function isEdgeVerifiable(edge: Edge, outcome: VerificationOutcome): boolean {
  if (!collectiveDecompositionValid(edge)) return false;
  if (edge.closure_policy === 'on-evidence') return outcome.verifiable;
  return true;
}

/**
 * Compose the adapter layer's M-8 bar with the node's.
 *
 * `@servanda/node`'s `mayAutoEscalate(edge, chain, now)` owns the half it can see: `due` is
 * non-null, the edge is still live, and the chain's collective check passed. It cannot see
 * whether an adapter exists, because adapters did not exist when it was written. Pass its
 * verdict in as `nodeVerdict`; this function is the AND.
 *
 * RECOMMENDED (orchestrator): fold this into `@servanda/node`'s `mayAutoEscalate` by having the
 * node call `verifyCommitment` and pass the outcome, so there is one entry point rather than a
 * composition callers must remember to perform. The composition is exposed here — rather than
 * left implicit — precisely so that forgetting it is visible in a diff.
 */
export function mayAutoEscalate(args: {
  edge: Edge;
  outcome: VerificationOutcome;
  nodeVerdict: boolean;
}): boolean {
  return args.nodeVerdict && isEdgeVerifiable(args.edge, args.outcome);
}
