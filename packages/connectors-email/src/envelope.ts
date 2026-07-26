import { MAX_LABEL, clip } from '@servanda/envelope';

/**
 * This connector's share of the §2 envelope boundary.
 *
 * The crossing itself — bounds, undefined-stripping, sealing — lives in `@servanda/envelope`
 * and is re-exported here so this package's public surface is unchanged. What stays local is
 * `label`: mail is the one source that can deliver a bidi override inside a display name, so
 * this connector strips Unicode *format* characters as well as controls. Keeping the rule
 * here makes that a visible decision rather than a silent difference between copies.
 */

export {
  MAX_PAYLOAD_TEXT,
  MAX_LABEL,
  MAX_REF,
  clip,
  compact,
  sealEnvelope,
} from '@servanda/envelope';

/**
 * Cc — the C0/C1 controls. Cf — format characters, which include the bidi overrides
 * (U+202A..U+202E, U+2066..U+2069) that can make a display name render as its own reverse.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

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

/**
 * M-12, at the connector boundary. A mail connector observes at §1.6 level 0 and cannot
 * prove otherwise: SPF/DKIM results are themselves headers in a message it cannot
 * authenticate. Rather than compute a level it has no evidence for, every envelope this
 * package emits carries this constant, so no downstream stage can mistake "we saw a From
 * header" for "this address is verified".
 */
export const FROM_VERIFICATION = 'none' as const;
