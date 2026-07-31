import { envelopeId } from '@servanda/crypto';
import { Envelope, UnidentifiedEnvelope } from '@servanda/types';

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

/** Payload strings are clipped: an envelope must stay bounded whatever the source does. */
export const MAX_PAYLOAD_TEXT = 8192;
export const MAX_LABEL = 200;
export const MAX_REF = 2048;

export function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

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
 */
export function sealEnvelope(candidate: unknown): Envelope {
  const base = UnidentifiedEnvelope.parse(candidate);
  return Envelope.parse({ ...base, id: envelopeId(base) });
}
