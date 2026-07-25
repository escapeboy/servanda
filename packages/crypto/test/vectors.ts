import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The conformance oracle. Vendored from github.com/escapeboy/servanda-protocol at the commit
 * pinned in vendor/vectors/.SOURCE_COMMIT; SERVANDA_VECTORS overrides the location so the
 * suite can be run against a working copy of the protocol repo.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
export const VECTORS_DIR =
  process.env['SERVANDA_VECTORS'] ?? resolve(here, '../../../vendor/vectors');

export function loadVectors<T>(relPath: string): T {
  return JSON.parse(readFileSync(join(VECTORS_DIR, relPath), 'utf8')) as T;
}

export interface CanonicalizationCase {
  name: string;
  description: string;
  input: string;
  canonical: string;
  sha256: string;
}

export interface HashingCase {
  name: string;
  description: string;
  commitment: {
    intent: string;
    owner: string;
    owed_to: string | null;
    due: string | null;
    created_at: string;
    [k: string]: unknown;
  };
  hash_preimage: Record<string, unknown>;
  hash_preimage_canonical: string;
  commitment_hash: string;
  same_hash_as_base: boolean;
}

export interface SignatureCase {
  name: string;
  description: string;
  signer: { persona_id: string; derivation_path: string };
  unsigned_object: Record<string, unknown>;
  canonical: string;
  sha256_preimage: string;
  signature: string;
  signed_object: Record<string, unknown>;
}

export interface DerivationVectors {
  purpose_constant: number;
  mnemonic: string;
  passphrase: string;
  seed: string;
  personas: Array<{
    persona_index: number;
    path: string;
    chain_code: string;
    private_key: string;
    public_key: string;
    persona_id: string;
  }>;
  org_root: {
    mnemonic: string;
    seed: string;
    [k: string]: unknown;
  };
}

export interface TransitionAssertion {
  v: string;
  type: 'assertion';
  edge_id: string;
  state: string;
  asserted_at: string;
  by: string;
  evidence_hash: string | null;
  sig: string;
}

export interface TransitionEdge {
  v: string;
  type: 'edge';
  edge_id: string;
  commitment_hash: string;
  owner: string;
  owed_to: string;
  proposed_at: string;
  due: string | null;
  closure_policy: 'on-evidence' | 'on-acceptance';
  acceptance_window: string | null;
  blocked_by: string[];
  supersedes: string | null;
  [k: string]: unknown;
}

export interface TransitionCase {
  name: string;
  description: string;
  edge: TransitionEdge;
  assertions: TransitionAssertion[];
  expected_outcomes: Array<{ index: number; accepted: boolean; rejection_reason?: string }>;
  expected_final_state: string;
}

export interface VectorFile<C> {
  suite_version: string;
  protocol_version: string;
  spec_reference: string;
  cases: C[];
}
