import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixtureNodeClient, loadApp, makeFixture as makeUiFixture } from '@servanda/client-web';
import { derivePersona, generateRootMnemonic, mnemonicToSeed } from '@servanda/crypto';
import { Vault } from '@servanda/vault';
import { LocalNodeClient, openRegister } from '../src/index.js';

/**
 * The gap this package closes, stated as a test.
 *
 * Before it, `FixtureNodeClient` was the only `NodeClient` in the repository: the vault stored
 * promises, the node served the five tools, and no shipped surface could show either. Every
 * client test passed, because every client test ran against invented data. The property that
 * nothing asserted was the one a person actually cares about — **that the register shows what
 * is in their vault**.
 *
 * So the load-bearing assertion here is not "the methods exist". It is that a promise written
 * through this client comes back out of a rendered brief, and that the fixture client — asked
 * the same question — answers with something else entirely. A bridge that returned plausible
 * data without reading the vault would pass the first check and fail the second.
 */

const PASSPHRASE = 'a passphrase that exists only in this test';

interface Opened {
  dir: string;
  client: LocalNodeClient;
  personaId: string;
}

function freshVault(): Opened {
  const dir = mkdtempSync(join(tmpdir(), 'servanda-client-local-'));
  const seed = mnemonicToSeed(generateRootMnemonic());
  const p = derivePersona(seed, 0);
  const vault = Vault.create({ dir, passphrase: PASSPHRASE });
  vault.putPersona({
    persona_id: p.personaId,
    persona_index: p.personaIndex,
    label: 'personal',
    scope_kind: 'personal',
    org_root: null,
    private_key: p.privateKey,
    created_at: vault.now(),
  });
  const opened = openRegister({ dir, passphrase: PASSPHRASE });
  return { dir, client: opened.client, personaId: opened.personaId };
}

describe('LocalNodeClient — the register reads the vault it lives in', () => {
  let opened: Opened;
  const INTENT = 'Send the audit letter to the housing co-operative';

  beforeAll(async () => {
    opened = freshVault();
    await opened.client.commit({
      intent: INTENT,
      owed_to: null,
      due: null,
      persona: null,
      propose: false,
    });
  });

  afterAll(() => {
    rmSync(opened.dir, { recursive: true, force: true });
  });

  it('starts from a vault that a person actually created, not a stand-in', () => {
    // openRegister resolved a persona out of the vault; if it had invented one, this id would
    // not be 64 hex characters derived from a real seed.
    expect(opened.personaId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the promise that was written, through the §7 tools', async () => {
    const loops = await opened.client.open_loops({ view: 'all', persona: null, limit: 50 });
    expect(loops.items.map((i) => i.intent_or_expect)).toContain(INTENT);
  });

  it('renders that promise into the brief the app draws', async () => {
    const app = await loadApp(opened.client, {
      surface: 'brief',
      now: new Date().toISOString(),
    });
    const rendered = JSON.stringify(app.brief);
    expect(rendered).toContain(INTENT);
  });

  it('the fixture client does NOT know this promise — proving the data came from the vault', async () => {
    // The control. Without it, a bridge that quietly fell back to fixture data — or one that
    // returned anything plausible — would pass every assertion above.
    const fixture = new FixtureNodeClient(makeUiFixture());
    const loops = await fixture.open_loops({ view: 'all', persona: null, limit: 50 });
    expect(loops.items.map((i) => i.intent_or_expect)).not.toContain(INTENT);
    expect(loops.items.length).toBeGreaterThan(0); // and it is not merely empty
  });

  it('an empty vault renders an empty register rather than inventing one', async () => {
    const empty = freshVault();
    try {
      const app = await loadApp(empty.client, {
        surface: 'brief',
        now: new Date().toISOString(),
      });
      expect(app.brief.cards).toHaveLength(0);
    } finally {
      rmSync(empty.dir, { recursive: true, force: true });
    }
  });

  it('names a persona by label or id, and refuses an unknown one by name', () => {
    expect(() => openRegister({ dir: opened.dir, passphrase: PASSPHRASE, persona: 'personal' })).not.toThrow();
    expect(() => openRegister({ dir: opened.dir, passphrase: PASSPHRASE, persona: opened.personaId })).not.toThrow();
    expect(() => openRegister({ dir: opened.dir, passphrase: PASSPHRASE, persona: 'nobody' })).toThrow(
      /no persona named "nobody"/,
    );
  });

  it('refuses the wrong passphrase — the vault is encrypted, not merely private', () => {
    expect(() => openRegister({ dir: opened.dir, passphrase: 'not the passphrase' })).toThrow();
  });
});
