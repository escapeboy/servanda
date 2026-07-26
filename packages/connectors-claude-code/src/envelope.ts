import { MAX_LABEL, clip } from '@servanda/envelope';

/**
 * This connector's share of the §2 envelope boundary.
 *
 * The crossing itself — bounds, undefined-stripping, sealing — lives in `@servanda/envelope`
 * and is re-exported here so this package's public surface is unchanged. What stays local is
 * `label`, because sanitising a display name is a question about *this* source.
 */

export {
  MAX_PAYLOAD_TEXT,
  MAX_LABEL,
  MAX_REF,
  clip,
  compact,
  sealEnvelope,
} from '@servanda/envelope';

/** Unicode general category Cc — the C0/C1 control characters. */
const CONTROL_CHARS = /\p{Cc}/gu;

/**
 * `actor.label` is rendered by clients, so control characters are stripped here. The
 * *content* stays attacker-influenced by nature (it is a commit author or a login); M-12
 * governs how much authority a client may grant it, not this connector.
 */
export function label(s: string): string {
  const flat = s.replace(CONTROL_CHARS, ' ').replace(/\s+/gu, ' ').trim();
  return clip(flat, MAX_LABEL) || 'unknown';
}
