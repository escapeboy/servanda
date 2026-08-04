import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadApp } from '@servanda/client-web';
import {
  ARGON2ID_CONSTRAINED,
  ARGON2ID_PARAMS,
  derivePersona,
  generateRootMnemonic,
  mnemonicToSeed,
} from '@servanda/crypto';
import { Vault } from '@servanda/vault';
import { openRegister } from '../src/index.js';

/**
 * The last link, which three sprints in a row left to nobody.
 *
 * Each of them built a surface and stopped at its boundary: ingestion became a library with no
 * driver, the register learned to page, the notices learned to render — and the thing that
 * ASSEMBLES them kept passing `pending: { items: [] }` with a comment about a limitation that had
 * been fixed. A surface reachable by a client author and invisible to a person is the same defect
 * as a value nobody renders, one level up.
 *
 * So the assertions here are about the ASSEMBLY, not about the pieces. Every piece already has
 * its own test and every one of them passed while the terminal showed nothing.
 */
const PASSPHRASE = 'a passphrase that exists only in this test';
const NOW = '2026-03-01T09:00:00Z';

describe('opening a register hands over everything a surface needs', () => {
  let dir: string;
  let opened: ReturnType<typeof openRegister>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'servanda-entry-'));
    const p = derivePersona(mnemonicToSeed(generateRootMnemonic()), 0);
    // The FLOOR profile — the one four published releases actually shipped. A vault made at the
    // current default would make the strength notice correctly silent, which is the state that
    // proves nothing.
    const vault = Vault.create({ dir, passphrase: PASSPHRASE, kdf: ARGON2ID_CONSTRAINED });
    vault.putPersona({
      persona_id: p.personaId,
      persona_index: p.personaIndex,
      label: 'personal',
      scope_kind: 'personal',
      org_root: null,
      private_key: p.privateKey,
      created_at: vault.now(),
    });
    opened = openRegister({ dir, passphrase: PASSPHRASE, stateDir: `${dir}-state` });
  }, 120_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    rmSync(`${dir}-state`, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('reports the vault it actually opened, not a default', () => {
    expect(opened.vaultStrength.profile).toEqual({
      m: ARGON2ID_CONSTRAINED.m,
      t: ARGON2ID_CONSTRAINED.t,
      p: ARGON2ID_CONSTRAINED.p,
    });
    expect(opened.vaultStrength.current).toEqual({
      m: ARGON2ID_PARAMS.m,
      t: ARGON2ID_PARAMS.t,
      p: ARGON2ID_PARAMS.p,
    });
    // Not empty. Telling somebody their setup is weak without saying what to run is worse
    // than silence, and that was the state for as long as the notice did not exist.
    expect(opened.vaultStrength.command.length).toBeGreaterThan(0);
  });

  it('and a surface built from it says so, in words', async () => {
    const app = await loadApp(opened.client, {
      surface: 'owe',
      now: NOW,
      vault: opened.vaultStrength,
      delivery: opened.delivery,
    });
    // This vault IS below the current default — it was made at the constrained profile on
    // purpose, which is the same profile four published releases shipped.
    expect(app.vault.weak).toBe(true);
    expect(app.vault.line).not.toBeNull();
    expect(app.vault.memoryFactor).toBeGreaterThan(1);
  });

  it('hands over delivery facts, empty rather than absent when nothing is queued', () => {
    expect(opened.delivery.items).toEqual([]);
  });

  it('and the confirmation queue is READ, not overridden with an empty list', async () => {
    const id = opened.node.queuePendingExtraction(
      opened.personaId,
      {
        v: 'servanda/0.2',
        type: 'commitment',
        owner: opened.personaId,
        owed_to: null,
        intent: 'something a model thought it heard',
        due: null,
        created_at: NOW,
        source: 'extracted',
      } as never,
      null,
    );
    expect(id.length).toBe(64);

    // `pending` deliberately NOT passed: undefined is what makes `loadApp` walk the view. The
    // terminal used to pass `{ items: [] }` explicitly, and an explicit empty value silences a
    // working feature exactly as thoroughly as a missing one.
    const app = await loadApp(opened.client, { surface: 'inbox', now: NOW });
    expect(app.inbox.cards.map((c) => c.id)).toContain(id);
  });
});
