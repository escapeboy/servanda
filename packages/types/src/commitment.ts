import { z } from 'zod';
import {
  ExternalLabel,
  KeyOrExternalLabel,
  ProtocolVersion,
  PublicKeyHex,
  Rfc3339,
  Sha256Hex,
} from './primitives.js';

/**
 * §3.1 Commitment (`layer: vault`). Plaintext lives only in party vaults (M-7);
 * what crosses the wire is the commitment_hash (§3.2).
 */

export const EvidenceRef = z.object({
  kind: z.enum(['envelope', 'url', 'commit', 'file']),
  value: z.string(),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

/** §3.1 `source` — how the record came to exist. */
export const CommitmentSource = z.enum([
  'extracted',
  'explicit',
  'archaeology',
  'converted_expectation',
]);
export type CommitmentSource = z.infer<typeof CommitmentSource>;

export const Commitment = z.object({
  v: ProtocolVersion,
  type: z.literal('commitment'),
  intent: z.string().min(1).max(500),
  owner: PublicKeyHex,
  /** null → reflexive (never leaves the vault); external_label → counterparty off-network. */
  owed_to: KeyOrExternalLabel.nullable(),
  due: Rfc3339.nullable(),
  /** §3.1: edge_ids this commitment is blocked_by. */
  conditions: z.array(Sha256Hex).default([]),
  evidence_refs: z.array(EvidenceRef).default([]),
  created_at: Rfc3339,
  source: CommitmentSource,
  confidence: z.number().min(0).max(1),
});
export type Commitment = z.infer<typeof Commitment>;

/**
 * §3.2 — the five fields that constitute the wire identity of the promise.
 * Evidence, confidence, source and conditions are deliberately excluded: two parties
 * agreeing on a promise need not share evidence sets.
 */
export const CommitmentHashPreimage = z.object({
  intent: z.string(),
  owner: PublicKeyHex,
  owed_to: KeyOrExternalLabel.nullable(),
  due: Rfc3339.nullable(),
  created_at: Rfc3339,
});
export type CommitmentHashPreimage = z.infer<typeof CommitmentHashPreimage>;

/**
 * §3.3 Expectation (`layer: vault`). ADR-0013: MUST NOT appear in any wire message.
 * "They said they would" is an expectation, never a proposal on their behalf (M-1).
 */
export const Expectation = z.object({
  v: ProtocolVersion,
  type: z.literal('expectation'),
  expect: z.string().min(1),
  from: z.union([ExternalLabel, PublicKeyHex]),
  since: Rfc3339,
  context_refs: z.array(EvidenceRef).default([]),
  state: z.enum(['open', 'closed']),
});
export type Expectation = z.infer<typeof Expectation>;

/**
 * §3.1 output shape of extraction (§3.4): extraction MUST emit only objects valid against
 * §3.1 or nothing. This is the schema the extractor is bound to.
 */
export const ExtractedCommitment = Commitment.extend({
  source: z.literal('extracted'),
});
export type ExtractedCommitment = z.infer<typeof ExtractedCommitment>;
