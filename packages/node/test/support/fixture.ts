import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARGON2ID_CONSTRAINED, derivePersona, mnemonicToSeed } from '@servanda/crypto';
import { PROTOCOL_VERSION } from '@servanda/types';
import { Vault, type PersonaRecord } from '@servanda/vault';
import { ServandaNode } from '../../src/node.js';

/**
 * Test fixtures. Keys come from the published BIP-39 test mnemonic the conformance vectors
 * use (all-zero entropy), so persona 0 and persona 1 here are the same keys as the transition
 * vectors' owner and owed_to — chains built in tests are directly comparable to the oracle.
 */
export const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon art';

export const TEST_PASSPHRASE = 'correct horse battery staple';

const seed = mnemonicToSeed(TEST_MNEMONIC);

export function persona(index: number) {
  return derivePersona(seed, index);
}

export interface Fixture {
  dir: string;
  vault: Vault;
  node: ServandaNode;
  personas: Record<number, string>;
  now: Date;
  setNow(d: Date): void;
  cleanup(): void;
}

export interface FixtureOptions {
  /** persona indices to create, with their local context labels. */
  personas?: { index: number; label: string; scope_kind?: 'personal' | 'org'; org_root?: string }[];
  activePersonaIndex?: number;
  now?: Date;
  retentionDays?: number;
}

export function makeFixture(opts: FixtureOptions = {}): Fixture {
  const spec = opts.personas ?? [
    { index: 0, label: 'me' },
    { index: 1, label: 'counterparty' },
  ];
  const dir = mkdtempSync(join(tmpdir(), 'servanda-vault-'));
  let now = opts.now ?? new Date('2026-07-25T09:00:00.000Z');
  const clock = () => now;

  const vault = Vault.create({
    kdf: ARGON2ID_CONSTRAINED,
    dir,
    passphrase: TEST_PASSPHRASE,
    now: clock,
    retentionDays: opts.retentionDays ?? 365,
  });

  const personas: Record<number, string> = {};
  for (const p of spec) {
    const derived = persona(p.index);
    personas[p.index] = derived.personaId;
    const record: PersonaRecord = {
      persona_id: derived.personaId,
      persona_index: p.index,
      label: p.label,
      scope_kind: p.scope_kind ?? 'personal',
      org_root: p.org_root ?? null,
      private_key: derived.privateKey,
      created_at: now.toISOString(),
    };
    vault.putPersona(record);
  }

  const activeIndex = opts.activePersonaIndex ?? spec[0]?.index ?? 0;
  const active = personas[activeIndex];
  if (!active) throw new Error(`fixture has no persona ${activeIndex}`);

  const node = new ServandaNode({ vault, activePersona: active, now: clock });

  return {
    dir,
    vault,
    node,
    personas,
    get now() {
      return now;
    },
    setNow(d: Date) {
      now = d;
    },
    cleanup() {
      // `force` swallows ENOENT and nothing else. Tearing down a git-backed vault raced on CI
      // and threw `ENOTEMPTY: rmdir '.git/info'`, which fails the whole FILE from `afterAll`
      // while every assertion in it passed — a green suite reported red. Retries are the
      // documented remedy: node's rm retries EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM, but only
      // when asked. Every temp-dir teardown in the repo carries the same options.
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

/**
 * What a transport would deliver (§6.2 `propose` / `assert`): the edge object and any
 * assertions the recipient lacks. Plaintext is never copied — a counterparty receives hashes
 * and states only (M-7). Used to stand up the two-party cases inside one test vault.
 */
export function syncEdge(fx: Fixture, fromIndex: number, toIndex: number, edgeId: string): void {
  const from = fx.personas[fromIndex];
  const to = fx.personas[toIndex];
  if (!from || !to) throw new Error('fixture is missing a persona');
  const edge = fx.vault.getEdge(from, edgeId);
  if (!edge) throw new Error(`persona ${fromIndex} does not hold edge ${edgeId}`);
  if (!fx.vault.getEdge(to, edgeId)) fx.vault.putEdge(to, edge);
  const have = new Set(fx.vault.getAssertions(to, edgeId).map((a) => a.sig));
  for (const a of fx.vault.getAssertions(from, edgeId)) {
    if (!have.has(a.sig)) fx.vault.appendAssertion(to, a);
  }
}

/** A node acting as a different persona over the same vault (the counterparty's side). */
export function nodeAs(fixture: Fixture, personaIndex: number): ServandaNode {
  const id = fixture.personas[personaIndex];
  if (!id) throw new Error(`fixture has no persona ${personaIndex}`);
  return new ServandaNode({
    vault: fixture.vault,
    activePersona: id,
    now: () => fixture.now,
  });
}

export const PV = PROTOCOL_VERSION;
