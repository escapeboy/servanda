import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitmentHash, derivePersona, edgeId, mnemonicToSeed, withSignature } from '@servanda/crypto';
import { Edge, Envelope, PROTOCOL_VERSION } from '@servanda/types';
import type { Assertion, EvidenceRef } from '@servanda/types';
import { AdapterCommitment } from '../../src/adapter.js';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon art';

const SEED = mnemonicToSeed(MNEMONIC);
export const persona = (i: number) => derivePersona(SEED, i);

export const OWNER = persona(0);
export const OWED_TO = persona(1);

export const REPO = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'archaeology-repo',
  'repo',
);
/** Pinned by `fixtures/archaeology-repo/EXPECTED.md`; gate GD asserts it too. */
export const REPO_HEAD = '8779acbf1753fc5ddf67a3ae76434880d171a710';

export const NOW = '2026-07-26T10:00:00Z';
const INTENT = 'ship the verification adapters';
const CREATED_AT = '2026-07-01T09:00:00Z';

export function commitment(refs: EvidenceRef[], overrides: Partial<AdapterCommitment> = {}) {
  return AdapterCommitment.parse({
    v: PROTOCOL_VERSION,
    type: 'commitment',
    owner: OWNER.personaId,
    owed_to: OWED_TO.personaId,
    due: '2026-07-20T00:00:00Z',
    conditions: [],
    evidence_refs: refs,
    created_at: CREATED_AT,
    source: 'explicit',
    confidence: 1,
    commitment_hash: commitmentHash({
      intent: INTENT,
      owner: OWNER.personaId,
      owed_to: OWED_TO.personaId,
      due: '2026-07-20T00:00:00Z',
      created_at: CREATED_AT,
    }),
    ...overrides,
  });
}

export function edge(overrides: Partial<Edge> = {}): Edge {
  const commitment_hash = commitmentHash({
    intent: INTENT,
    owner: OWNER.personaId,
    owed_to: OWED_TO.personaId,
    due: '2026-07-20T00:00:00Z',
    created_at: CREATED_AT,
  });
  const proposed_at = '2026-07-01T09:00:00Z';
  return Edge.parse({
    v: PROTOCOL_VERSION,
    type: 'edge',
    edge_id: edgeId({
      commitment_hash,
      owner: OWNER.personaId,
      owed_to: OWED_TO.personaId,
      proposed_at,
    }),
    commitment_hash,
    owner: OWNER.personaId,
    owed_to: OWED_TO.personaId,
    proposed_at,
    due: '2026-07-20T00:00:00Z',
    closure_policy: 'on-evidence',
    acceptance_window: null,
    blocked_by: [],
    supersedes: null,
    ...overrides,
  });
}

/** A signed §4.2 assertion. Tests sign as a party; adapters never can (M-13). */
export function assertion(args: {
  edge_id: string;
  state: Assertion['state'];
  by: { personaId: string; privateKey: string };
  asserted_at: string;
  evidence_hash: string | null;
}): Assertion {
  return withSignature(
    {
      v: PROTOCOL_VERSION,
      type: 'assertion' as const,
      edge_id: args.edge_id,
      state: args.state,
      asserted_at: args.asserted_at,
      by: args.by.personaId,
      evidence_hash: args.evidence_hash,
    },
    args.by.privateKey,
  ) as Assertion;
}

/** A §2 envelope in the shape `@servanda/connectors-github` emits for a check run. */
export function ciEnvelope(overrides: Record<string, unknown> = {}): Envelope {
  return Envelope.parse({
    v: PROTOCOL_VERSION,
    type: 'envelope',
    id: 'c'.repeat(64),
    source: 'ci',
    kind: 'check_run',
    occurred_at: '2026-07-18T12:00:00Z',
    received_at: '2026-07-18T12:00:03Z',
    actor: { label: 'github-actions[bot]' },
    payload: {
      repo: 'studio/billing',
      check_run_id: 99123,
      text: 'ci / test',
      status: 'completed',
      conclusion: 'success',
      completed_at: '2026-07-18T12:00:00Z',
      head_sha: REPO_HEAD,
      html_url: 'https://github.example/checks/99123',
    },
    refs: [{ kind: 'commit', value: REPO_HEAD }],
    persona: OWNER.personaId,
    ...overrides,
  });
}

/** A scratch workspace for the `file` adapter. Never the user's tree. */
export function workspace(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'servanda-adapters-'));
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
