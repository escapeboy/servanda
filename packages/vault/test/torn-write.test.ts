import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Power loss in the middle of a write, applied to the case that loses data: an OVERWRITE.
 *
 * `writeFileSync` to the destination is not one operation — it truncates and then writes — so an
 * interruption between the two leaves a prefix of the new record where the whole of the old one
 * was. For an append that costs the new record. For `meta.json`, `retention.json` or
 * `keyset.json` it costs the record that was already there, and `keyset.json` is the vault.
 *
 * The interruption is real rather than argued: `node:fs` is patched so that one named write
 * commits a prefix of its bytes and then throws ENOSPC, which is what a disk that filled up during
 * a write actually does. Under a direct write the record is destroyed; under a write-and-rename it
 * cannot be, because the destination is never opened for writing at all.
 */

const control = vi.hoisted(() => ({ tearWritesTo: null as string | null }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    writeFileSync: (path: unknown, data: unknown, options?: unknown) => {
      if (control.tearWritesTo !== null && String(path).includes(control.tearWritesTo)) {
        control.tearWritesTo = null;
        const half = String(data).slice(0, Math.floor(String(data).length / 2));
        actual.writeFileSync(path as string, half, 'utf8');
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      return actual.writeFileSync(path as never, data as never, options as never);
    },
  };
});

import { ARGON2ID_CONSTRAINED, derivePersona, mnemonicToSeed } from '@servanda/crypto';
import { Vault } from '../src/index.js';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon art';
const PASSPHRASE = 'correct horse battery staple';
const p0 = derivePersona(mnemonicToSeed(MNEMONIC), 0);
const EDGE = 'ab'.repeat(16);

const dirs: string[] = [];
afterEach(() => {
  control.tearWritesTo = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('the disk fills up in the middle of a write', () => {
  it('does not destroy the record that was already there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'servanda-torn-'));
    dirs.push(dir);
    const vault = Vault.create({ dir, passphrase: PASSPHRASE, kdf: ARGON2ID_CONSTRAINED });
    vault.putPersona({
      persona_id: p0.personaId,
      persona_index: 0,
      label: 'me',
      scope_kind: 'personal',
      org_root: null,
      private_key: p0.privateKey,
      created_at: '2026-07-25T09:00:00Z',
    });
    vault.putEdgeMeta(p0.personaId, { edge_id: EDGE, dismissed: false, plaintext_deleted_at: null });

    control.tearWritesTo = 'meta.json';
    expect(() =>
      vault.putEdgeMeta(p0.personaId, { edge_id: EDGE, dismissed: true, plaintext_deleted_at: null }),
    ).toThrow(/ENOSPC/);

    // The write failed, so the old value is the right answer — and it is still THERE to be the
    // answer. A direct write would have left half of the new record in its place, and this read
    // would fail rather than return anything.
    expect(vault.getEdgeMeta(p0.personaId, EDGE).dismissed).toBe(false);
  });

  it('leaves no half-written file behind in the vault', () => {
    const dir = mkdtempSync(join(tmpdir(), 'servanda-torn-'));
    dirs.push(dir);
    const vault = Vault.create({ dir, passphrase: PASSPHRASE, kdf: ARGON2ID_CONSTRAINED });
    vault.putPersona({
      persona_id: p0.personaId,
      persona_index: 0,
      label: 'me',
      scope_kind: 'personal',
      org_root: null,
      private_key: p0.privateKey,
      created_at: '2026-07-25T09:00:00Z',
    });

    control.tearWritesTo = 'persona.json';
    expect(() =>
      vault.putPersona({
        persona_id: p0.personaId,
        persona_index: 0,
        label: 'renamed',
        scope_kind: 'personal',
        org_root: null,
        private_key: p0.privateKey,
        created_at: '2026-07-25T09:00:00Z',
      }),
    ).toThrow(/ENOSPC/);

    // The temporary is removed on the way out, so the next `git add -A` does not commit debris and
    // no listing has to reason about it.
    expect(readdirSync(join(dir, 'personas', p0.personaId)).filter((f) => f.startsWith('.'))).toEqual([]);
    expect(vault.getPersona(p0.personaId).label).toBe('me');
  });
});
