import { hashCanonical, verifyObject, withSignature } from '@servanda/crypto';
import type { WireMessage, WireMessageType } from '@servanda/types';
import { PROTOCOL_VERSION, WireMessage as WireMessageSchema } from '@servanda/types';

/**
 * §6.2 wire messages — `{ v, type, payload, sender, sent_at, sig }`, signed by the sender
 * persona and verified at the recipient.
 *
 * §6.3: "fabrication is prevented by signature verification at recipients regardless of hub
 * honesty". That sentence is the reason `verifyMessage` returns `null` rather than throwing:
 * a forged or mangled message from an untrusted courier is an expected condition on this
 * layer, not an exception. Every inbound path must go through it before anything is stored.
 */

export function signMessage(
  type: WireMessageType,
  payload: unknown,
  sender: string,
  recipient: string,
  sentAt: string,
  privateKeyHex: string,
): WireMessage {
  return withSignature(
    { v: PROTOCOL_VERSION, type, payload, sender, recipient, sent_at: sentAt },
    privateKeyHex,
  ) as WireMessage;
}

/**
 * Parse and verify. Returns the message only when it is well-formed AND its `sig` verifies
 * under the key it names as `sender`.
 */
export function verifyMessage(raw: unknown): WireMessage | null {
  const parsed = WireMessageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const message = parsed.data;
  if (!verifyObject(message as unknown as Record<string, unknown>, message.sender)) return null;
  return message;
}

/**
 * Does this object claim a protocol version this node speaks? Asked BEFORE anything else.
 *
 * §00: "the `v` field exists so a node can refuse rather than misinterpret." It did refuse — and
 * it reported every refusal as `signature-does-not-verify`, because `verifyMessage` collapses a
 * schema failure and a signature failure into one `null`. A correctly signed `servanda/0.1`
 * message was logged as a forgery. An operator watching a peer roll out a new version sees an
 * attack instead of a version skew, and the peer's signatures were never in question.
 *
 * This is the same defect the discard-reason list already fixed once, for
 * `addressed-to-another-persona` — a message that verifies perfectly and is addressed to somebody
 * else is a re-sealed message, not a corrupt one, and an operator reading a log needs those apart.
 */
export function speaksThisVersion(raw: unknown): boolean {
  const v = (raw as { v?: unknown } | null | undefined)?.v;
  return v === PROTOCOL_VERSION;
}

/** Content address of a message. Used to deduplicate deliveries — transports may replay. */
export function messageId(message: WireMessage): string {
  return hashCanonical(message as unknown as Record<string, unknown>);
}

/**
 * The edge a message concerns, or null for messages that are not edge-scoped
 * (`recon_*`, `recover_*`, identity statements). The git transport keys its directory layout
 * on this (§6.1: `servanda/{edge_id}/{seq}-{type}.json`).
 */
export function edgeIdOf(message: WireMessage): string | null {
  const p = message.payload as Record<string, unknown> | null | undefined;
  if (p === null || typeof p !== 'object') return null;
  switch (message.type) {
    case 'propose': {
      const edge = p['edge'] as { edge_id?: unknown } | undefined;
      return typeof edge?.edge_id === 'string' ? edge.edge_id : null;
    }
    case 'assert': {
      const assertion = p['assertion'] as { edge_id?: unknown } | undefined;
      return typeof assertion?.edge_id === 'string' ? assertion.edge_id : null;
    }
    case 'publish':
    case 'unpublish':
      return typeof p['edge_id'] === 'string' ? (p['edge_id'] as string) : null;
    default:
      return null;
  }
}
