import { z } from 'zod';
import { PersonaId, ProtocolVersion, Rfc3339, Sha256Hex } from '@servanda/types';

/** Vault-local record shapes. None of these is a wire object; none ever leaves the vault. */

/**
 * §1.2 — the vault records `{persona_index → context_label}`. The private key lives here and
 * nowhere else. M-13: signing keys belong to personas; an agent gets a handle, never a key.
 */
export const PersonaRecord = z.object({
  persona_id: PersonaId,
  persona_index: z.number().int().nonnegative(),
  label: z.string().min(1),
  /** Which scope this persona acts in. §5.1: personal(persona) · org(org_root) · team(group_key). */
  scope_kind: z.enum(['personal', 'org']),
  org_root: PersonaId.nullable(),
  private_key: z.string().regex(/^[0-9a-f]{64}$/),
  created_at: Rfc3339,
});
export type PersonaRecord = z.infer<typeof PersonaRecord>;

/**
 * §7 `confirm` serves "the local extraction-confirmation queue" as well as inbound proposals.
 * A pending item is an extraction result awaiting a human act; it is not yet a commitment.
 */
export const PendingExtraction = z.object({
  v: ProtocolVersion,
  type: z.literal('pending_extraction'),
  id: Sha256Hex,
  persona: PersonaId,
  /** The §3.1 candidate, unconfirmed. `source` is always "extracted" (§3.4). */
  candidate: z.record(z.unknown()),
  envelope_id: Sha256Hex.nullable(),
  queued_at: Rfc3339,
});
export type PendingExtraction = z.infer<typeof PendingExtraction>;

/**
 * A wire message this node produced but has not handed to any transport. L0–L1 has no
 * network (M-10): `propose` writes here and stops. Stream B's transports drain it.
 */
export const OutboxItem = z.object({
  v: ProtocolVersion,
  type: z.literal('outbox_item'),
  id: Sha256Hex,
  persona: PersonaId,
  recipient: PersonaId,
  message: z.record(z.unknown()),
  queued_at: Rfc3339,
});
export type OutboxItem = z.infer<typeof OutboxItem>;

/** Local bookkeeping attached to an edge: dismissal, retention state. Never on the wire. */
export const EdgeMeta = z.object({
  edge_id: Sha256Hex,
  /** §6.5: a proposal is socially nothing; dismissing one produces no assertion. */
  dismissed: z.boolean().default(false),
  /** M-15: set when the commitment plaintext was deleted but the edge was kept. */
  plaintext_deleted_at: Rfc3339.nullable().default(null),
});
export type EdgeMeta = z.infer<typeof EdgeMeta>;

/**
 * §5.4 retention policy. Personal scopes MUST NOT support escrow (M-15) — there is
 * deliberately no escrow field on this record at all, so no personal-scope escrow can be
 * expressed, let alone enabled.
 */
export const RetentionPolicy = z.object({
  v: ProtocolVersion,
  type: z.literal('retention_policy'),
  retention_days: z.number().int().nonnegative(),
});
export type RetentionPolicy = z.infer<typeof RetentionPolicy>;

export const DEFAULT_RETENTION_DAYS = 365;

/**
 * The ONLY shape that may cross persona boundaries (§5.3 M-5: "ordering of opaque items in the
 * personal queue is the sole exception"). It carries no `intent`, no `expect`, no counterparty
 * label — nothing a ranking pipeline could mistake for content. Adding a text field here would
 * be an M-5 violation, and `M-05.test.ts` asserts the field list.
 */
export interface OrderingKey {
  persona: string;
  kind: 'commitment' | 'expectation' | 'edge';
  id: string;
  /** Age basis: created_at / since / proposed_at, depending on kind. */
  since: string;
  due: string | null;
  blocking_count: number;
  state: string;
}

/** Field names permitted on an OrderingKey. Asserted by the M-5 test. */
export const ORDERING_KEY_FIELDS: readonly string[] = [
  'persona',
  'kind',
  'id',
  'since',
  'due',
  'blocking_count',
  'state',
] as const;
