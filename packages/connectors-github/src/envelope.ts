import { hashCanonical } from '@servanda/crypto';
import { Envelope, UnidentifiedEnvelope } from '@servanda/types';

/**
 * The connector-side envelope boundary.
 *
 * NOTE: this file is deliberately duplicated in @servanda/connectors-claude-code. The two
 * connector packages own no shared package, and the alternative — one connector importing
 * the other — would make an unrelated dependency load-bearing. Twenty lines is cheaper.
 *
 * §2 / M-6: everything that comes from the observed world is DATA. It goes under `payload`
 * (or `refs`/`actor`, which are descriptive), never into `source`, `kind`, `persona`, or a
 * timestamp — the fields a pipeline stage reads to decide what to do.
 */

/** Payload strings are clipped: an envelope must stay bounded whatever the source does. */
export const MAX_PAYLOAD_TEXT = 8192;
export const MAX_LABEL = 200;
export const MAX_REF = 2048;

/** Unicode general category Cc — the C0/C1 control characters. */
const CONTROL_CHARS = /\p{Cc}/gu;

export function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

/**
 * `actor.label` is rendered by clients, so control characters are stripped here. The
 * *content* stays attacker-influenced by nature (it is a commit author or a login); M-12
 * governs how much authority a client may grant it, not this connector.
 */
export function label(s: string): string {
  const flat = s.replace(CONTROL_CHARS, ' ').replace(/\s+/gu, ' ').trim();
  return clip(flat, MAX_LABEL) || 'unknown';
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
 * §2: `id` = sha256 of the canonical form sans id. Parsing before hashing is what makes the
 * id well-defined — zod fills `refs` and strips unknown keys, so two callers that built the
 * same envelope differently still hash the same bytes.
 */
export function sealEnvelope(candidate: unknown): Envelope {
  const base = UnidentifiedEnvelope.parse(candidate);
  return Envelope.parse({ ...base, id: hashCanonical(base) });
}

/** RFC 3339 in UTC, seconds precision. Every git timestamp is normalized through this. */
export function rfc3339FromEpochSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/u, 'Z');
}
