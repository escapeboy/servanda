import { envelopeId } from '@servanda/crypto';
import { Envelope, UnidentifiedEnvelope } from '@servanda/types';
import { bound, boundsViolation } from './bounds.js';

/**
 * The connector-side envelope boundary.
 *
 * Every connector crosses the same line: something from the observed world becomes a §2
 * envelope. The crossing is identical wherever it happens — the same bounds, the same
 * undefined-stripping, the same sealing — so it is written once here rather than once per
 * connector. It previously existed as three byte-identical copies, on the reasoning that no
 * shared package existed and making one connector depend on another would put an unrelated
 * package on the critical path. That objection was to a dependency *between connectors*; this
 * package is the shared home it assumed did not exist. `sealEnvelope` computes the envelope
 * id by hashing, so a copy that drifted would not merely duplicate code — it would give the
 * same observation two different identities.
 *
 * §2 / M-6: everything that comes from the observed world is DATA. It goes under `payload`
 * (or `refs`/`actor`, which are descriptive), never into `source`, `kind`, `persona`, or a
 * timestamp — the fields a pipeline stage reads to decide what to do.
 *
 * What is NOT here: `label`. Each connector sanitises display names against the attacks its
 * own source can actually deliver, and those differ. Keeping it per-connector makes that a
 * visible decision instead of an invisible divergence between near-identical files.
 */

export {
  MAX_ENVELOPE_OCTETS,
  MAX_PAYLOAD_TEXT,
  MAX_PAYLOAD_DEPTH,
  MAX_REFS,
  MAX_REF,
  MAX_LABEL,
  boundsViolation,
  clip,
  octets,
} from './bounds.js';

/** Drops keys whose value is undefined: JCS has no representation for them. */
export function compact(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) {
    if (o[k] !== undefined) out[k] = o[k];
  }
  return out;
}

/**
 * §2: `id` = sha256(domain tag || JCS(envelope sans id)). Parsing before hashing is what makes
 * the id well-defined — zod fills `refs` and strips unknown keys, so two callers that built the
 * same envelope differently still hash the same bytes.
 *
 * The tag itself lives in `@servanda/crypto` with the other two identifier tags, so §0's single
 * rule has a single home.
 *
 * M-19: the bounds are applied HERE, not left to each connector, because this is the only place
 * that sees the envelope whole. A connector clipping a string on its own can keep a value inside
 * the bound and still leave the envelope silently truncated — nothing downstream would know a cut
 * happened. Bounding at the seal means every emitted envelope is inside §2 and carries `clipped`
 * whenever it had to be brought there.
 */
/**
 * The node half of M-19: an envelope that arrives already formed is REJECTED if it exceeds a
 * bound, never canonicalized and never quietly re-clipped.
 *
 * Re-clipping would be the tempting thing and it is wrong twice over: it changes the canonical
 * form, so the `id` this node computes stops matching the one its sender computed, and it hides
 * that the sender emitted something §2 forbids.
 *
 * This implementation has no ingress for foreign envelopes — its connectors are libraries called
 * in-process, the divergence from §2's `emit_envelope` recorded in the README — so nothing calls
 * `acceptEnvelope` today. It exists because the obligation is on the node, not on the connector,
 * and a rule with no callable form is a rule nothing can be held to.
 */
export class EnvelopeBoundsExceeded extends RangeError {
  override name = 'EnvelopeBoundsExceeded';
  constructor(reason: string) {
    super(`§2 bounds exceeded: ${reason}. Rejecting the envelope rather than canonicalizing it.`);
  }
}

export function sealEnvelope(candidate: unknown): Envelope {
  const base = UnidentifiedEnvelope.parse(candidate);
  const bounded = UnidentifiedEnvelope.parse(bound(base));
  // The seal states its own postcondition rather than assuming it.
  //
  // `bound` reduces `payload` and `refs`, which are the members §2 gives it room to reduce.
  // `source`, `kind` and `actor.external_id` it cannot touch — §2 states no bound for them, and
  // shortening a `kind` would change what the observation says it is. So an oversized one
  // survives the reduction, and the envelope leaves here over the whole-form bound.
  //
  // Emitting it would be the worst of the three outcomes: `id` computed over a canonical form §2
  // forbids, stored locally, and refused by every conforming node that ever sees it — with
  // nothing anywhere saying why. Failing names the member instead, and the connector is the only
  // layer that can shorten it.
  const reason = boundsViolation(bounded);
  if (reason !== null) throw new EnvelopeBoundsExceeded(reason);
  return Envelope.parse({ ...bounded, id: envelopeId(bounded) });
}

export function acceptEnvelope(candidate: unknown): Envelope {
  const reason = boundsViolation(candidate);
  if (reason !== null) throw new EnvelopeBoundsExceeded(reason);
  return Envelope.parse(candidate);
}
