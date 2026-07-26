#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { derivePersona, generateRootMnemonic, isValidMnemonic, mnemonicToSeed } from '@servanda/crypto';
import { Vault } from '@servanda/vault';

/**
 * Create a vault and its first persona.
 *
 * Until this existed the software could not be started: `servanda-node` opens a vault and there
 * was no way to make one, so the only path in was to write a TypeScript program. That is not a
 * product, and `ui-design.md`'s non-technical-default law rules it out in as many words.
 *
 *   SERVANDA_VAULT       vault directory (required)
 *   SERVANDA_PASSPHRASE  vault passphrase (required)
 *   SERVANDA_MNEMONIC    24-word BIP-39 recovery phrase (optional; generated when absent)
 *   SERVANDA_LABEL       what this persona is for (default "personal")
 *   SERVANDA_INDEX       persona index within the seed (default 0)
 *
 * The passphrase is read from the environment rather than a flag because a flag lands in shell
 * history and in `ps`. The recovery phrase is printed once, to stdout, and never stored: §1.1
 * makes it the root of everything, and a copy the program keeps is a copy an attacker can take.
 */

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function main(): void {
  const dir = process.env['SERVANDA_VAULT'];
  const passphrase = process.env['SERVANDA_PASSPHRASE'];
  if (!dir) fail('SERVANDA_VAULT is required (the directory to create the vault in)');
  if (!passphrase) {
    fail(
      'SERVANDA_PASSPHRASE is required.\n' +
        'M-16: a device key must never be the sole custodian of the vault content key, so a ' +
        'passphrase is not optional — without it, losing the device loses the vault.',
    );
  }

  if (existsSync(`${dir}/.git`)) {
    fail(`a vault already exists at ${dir}; refusing to overwrite it`);
  }

  const supplied = process.env['SERVANDA_MNEMONIC'];
  if (supplied !== undefined && !isValidMnemonic(supplied)) {
    fail('SERVANDA_MNEMONIC is not a valid BIP-39 phrase (checksum or wordlist failure)');
  }
  const mnemonic = supplied ?? generateRootMnemonic();
  const restored = supplied !== undefined;

  const index = Number.parseInt(process.env['SERVANDA_INDEX'] ?? '0', 10);
  if (!Number.isInteger(index) || index < 0) fail('SERVANDA_INDEX must be a non-negative integer');

  const persona = derivePersona(mnemonicToSeed(mnemonic), index);
  const label = process.env['SERVANDA_LABEL'] ?? 'personal';

  const vault = Vault.create({ dir, passphrase, author: { name: 'servanda', email: 'servanda@localhost' } });
  vault.putPersona({
    persona_id: persona.personaId,
    persona_index: persona.personaIndex,
    label,
    scope_kind: 'personal',
    org_root: null,
    private_key: persona.privateKey,
    created_at: vault.now(),
  });

  const out = process.stdout;
  out.write(`\nVault created at ${dir}\n`);
  out.write(`Persona   ${persona.personaId}\n`);
  out.write(`Path      ${persona.path}\n`);
  out.write(`Label     ${label}\n`);

  if (restored) {
    out.write('\nDerived from the phrase you supplied. Same phrase, same keys — always.\n');
    return;
  }

  // Printed once and never written down by the program. ADR-0014: this phrase, an org
  // re-attestation, or an external binding proof are the only ways back — a persona with none of
  // them is unrecoverable by design, which is a property rather than an oversight.
  out.write('\n─────────────────────────────────────────────────────────────────────\n');
  out.write('RECOVERY PHRASE — write it down now. It is shown once and stored nowhere.\n');
  out.write('─────────────────────────────────────────────────────────────────────\n');
  const words = mnemonic.split(' ');
  for (let i = 0; i < words.length; i += 6) {
    out.write(`  ${words.slice(i, i + 6).join(' ')}\n`);
  }
  out.write('─────────────────────────────────────────────────────────────────────\n');
  out.write('Anyone holding these words holds every persona derived from them.\n');
  out.write('Losing them and the passphrase together loses the vault.\n\n');
}

main();
