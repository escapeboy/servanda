import { hashCanonical } from '@servanda/crypto';
import { Envelope, UnidentifiedEnvelope } from '@servanda/types';

/**
 * The connector-side envelope boundary.
 *
 * NOTE: this file is deliberately duplicated from @servanda/connectors-github and
 * @servanda/connectors-claude-code, for the reason stated there: the connector packages own
 * no shared package, and making one connector depend on another would put an unrelated
 * package on the critical path. The email connector adds one rule of its own — `label`
 * also strips Unicode *format* characters (`\p{Cf}`), because bidi overrides in a mail
 * display name are a rendering attack the other two sources cannot deliver.
 *
 * §2 / M-6: everything that comes from the observed world is DATA. It goes under `payload`
 * (or `refs`/`actor`, which are descriptive), never into `source`, `kind`, `persona`, or a
 * timestamp — the fields a pipeline stage reads to decide what to do.
 */

/** Payload strings are clipped: an envelope must stay bounded whatever the source does. */
export const MAX_PAYLOAD_TEXT = 8192;
export const MAX_LABEL = 200;
export const MAX_REF = 2048;

/**
 * Cc — the C0/C1 controls. Cf — format characters, which include the bidi overrides
 * (U+202A..U+202E, U+2066..U+2069) that can make a display name render as its own reverse.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

export function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

/**
 * `actor.label` is rendered by clients, so invisible characters are stripped here. The
 * *content* stays attacker-influenced by nature (a `From` display name is written by
 * whoever sent the mail); M-12 governs how much authority a client may grant it, and §1.6
 * decides identity. This connector never claims a level (see `FROM_VERIFICATION`).
 */
export function label(s: string): string {
  const flat = s.replace(INVISIBLE, ' ').replace(/\s+/gu, ' ').trim();
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

/**
 * M-12, at the connector boundary. A mail connector observes at §1.6 level 0 and cannot
 * prove otherwise: SPF/DKIM results are themselves headers in a message it cannot
 * authenticate. Rather than compute a level it has no evidence for, every envelope this
 * package emits carries this constant, so no downstream stage can mistake "we saw a From
 * header" for "this address is verified".
 */
export const FROM_VERIFICATION = 'none' as const;
