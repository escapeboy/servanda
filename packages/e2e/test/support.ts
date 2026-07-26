import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { derivePersona, mnemonicToSeed } from '@servanda/crypto';
import { Vault } from '@servanda/vault';
import { ServandaNode } from '@servanda/node';

const here = fileURLToPath(new URL('.', import.meta.url));
export const REPO_ROOT = resolve(here, '../../..');
export const FIXTURE_REPO = join(REPO_ROOT, 'fixtures/archaeology-repo/repo');
/** Pinned in gate GB; the fixture regenerates to this exact commit on any machine. */
export const FIXTURE_HEAD = '8779acbf1753fc5ddf67a3ae76434880d171a710';

/**
 * The fixture is generated, not committed — a nested .git would become a gitlink. Materialize it
 * on demand so a fresh clone can run the integration suite without a separate setup step.
 */
export function ensureFixtureRepo(): string {
  if (!existsSync(join(FIXTURE_REPO, '.git'))) {
    execFileSync('bash', [join(REPO_ROOT, 'fixtures/archaeology-repo/setup.sh')], {
      stdio: 'pipe',
    });
  }
  return FIXTURE_REPO;
}

/** Published BIP-39 test mnemonic — the same one the conformance vectors use. */
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

export const seed = mnemonicToSeed(TEST_MNEMONIC);
export const alice = derivePersona(seed, 0);
export const bob = derivePersona(seed, 1);

/**
 * A clock the test drives. Every scenario is a story with dates in it, and a story whose
 * outcome depends on when it is run is not a test.
 */
export class TestClock {
  constructor(private instant: Date) {}
  now = (): Date => this.instant;
  iso(): string {
    return this.instant.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  advanceDays(days: number): void {
    this.instant = new Date(this.instant.getTime() + days * 86_400_000);
  }
}

export interface Install {
  vault: Vault;
  node: ServandaNode;
  clock: TestClock;
  dir: string;
}

/** A fresh install: new vault, one persona, nothing in it. */
export async function freshInstall(startInstant: string, persona = alice): Promise<Install> {
  const dir = mkdtempSync(join(tmpdir(), 'servanda-e2e-'));
  const clock = new TestClock(new Date(startInstant));
  const vault = await Vault.create({
    dir: join(dir, 'vault'),
    passphrase: 'e2e-passphrase-of-record',
    author: { name: 'e2e', email: 'e2e@servanda.test' },
    now: clock.now,
  });
  vault.putPersona({
    persona_id: persona.personaId,
    persona_index: persona.personaIndex,
    label: 'e2e',
    scope_kind: 'personal',
    org_root: null,
    private_key: persona.privateKey,
    created_at: clock.iso(),
  });
  const node = new ServandaNode({ vault, activePersona: persona.personaId, now: clock.now });
  return { vault, node, clock, dir };
}
