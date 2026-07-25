import { z } from 'zod';
import { ProtocolVersion, PublicKeyHex, Rfc3339, Sha256Hex, SignatureHex } from './primitives.js';

/**
 * §5 Scopes & visibility. A scope is identified by its controlling key.
 * No deeper nesting in v0.
 */

export const ScopeKind = z.enum(['personal', 'org', 'team']);
export type ScopeKind = z.infer<typeof ScopeKind>;

export const Scope = z.object({
  kind: ScopeKind,
  /** persona key for personal, org_root for org, group key for team. */
  key: PublicKeyHex,
});
export type Scope = z.infer<typeof Scope>;

/**
 * §5.4 — scope retention policy MUST be visible to scope members; org escrow, if enabled
 * for a team scope, MUST be announced here. Personal scopes MUST NOT support escrow (M-15).
 */
export const ScopeDescriptor = z.object({
  v: ProtocolVersion,
  type: z.literal('scope_descriptor'),
  scope: Scope,
  retention_days: z.number().int().nonnegative().nullable(),
  escrow: z.object({ enabled: z.boolean(), holder: PublicKeyHex.optional() }),
});
export type ScopeDescriptor = z.infer<typeof ScopeDescriptor>;

/** §5.2 — only a party to the edge may publish it, into scopes the publisher belongs to. */
export const Publish = z.object({
  v: ProtocolVersion,
  type: z.literal('publish'),
  edge_id: Sha256Hex,
  scope: PublicKeyHex,
  published_at: Rfc3339,
  by: PublicKeyHex,
  sig: SignatureHex,
});
export type Publish = z.infer<typeof Publish>;

export const Unpublish = z.object({
  v: ProtocolVersion,
  type: z.literal('unpublish'),
  edge_id: Sha256Hex,
  scope: PublicKeyHex,
  published_at: Rfc3339,
  by: PublicKeyHex,
  sig: SignatureHex,
});
export type Unpublish = z.infer<typeof Unpublish>;
