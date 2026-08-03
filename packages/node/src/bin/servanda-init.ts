#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { derivePersona, generateRootMnemonic, isValidMnemonic, mnemonicToSeed } from '@servanda/crypto';
import { Vault, VAULT_MARKER } from '@servanda/vault';

/**
 * Create a vault and its first persona, or add another persona to a vault that exists.
 *
 * Until this existed the software could not be started: `servanda-node` opens a vault and there
 * was no way to make one, so the only path in was to write a TypeScript program. That is not a
 * product, and `ui-design.md`'s non-technical-default law rules it out in as many words.
 *
 *   SERVANDA_VAULT       vault directory (required)
 *   SERVANDA_PASSPHRASE  vault passphrase (required)
 *   SERVANDA_MNEMONIC    24-word BIP-39 recovery phrase (optional on create; required to add)
 *   SERVANDA_LABEL       what this persona is for (default "personal")
 *   SERVANDA_INDEX       persona index within the seed (default 0)
 *
 * The passphrase is read from the environment rather than a flag because a flag lands in shell
 * history and in `ps`. The recovery phrase is printed once, to stdout, and never stored: §1.1
 * makes it the root of everything, and a copy the program keeps is a copy an attacker can take.
 *
 * The work is `runInit`, not the module body, so a test can drive every refusal in-process. A
 * bin that can only be tested by spawning the BUILT copy is a bin whose tests pass against the
 * last build rather than the current source.
 */

/** A refusal with a sentence for its reader. `main` turns it into exit code 2. */
export class InitError extends Error {
  override name = 'InitError';
}

function fail(message: string): never {
  throw new InitError(message);
}

/**
 * SLIP-0010 hardened child indices are 31-bit. Beyond that `derivePersona` throws a RangeError
 * with a stack trace, which is a crash report where a sentence was owed.
 */
const MAX_PERSONA_INDEX = 2 ** 31 - 1;

const PHRASE_WORDS = 24;

export type Env = Record<string, string | undefined>;
export interface InitIo {
  out(text: string): void;
  /** Progress and warnings. Never the persona block — that is the program's answer. */
  log(text: string): void;
}

/**
 * A phrase written down is a phrase transcribed back: down a column, in capitals, with a stray
 * space at either end. Those are the SAME 24 words, and BIP-39 validation does not know it —
 * `isValidMnemonic` fails all three identically to a wrong word. Refusing a correct phrase is the
 * worst error this program can make, because USAGE.md tells its holder those words are the only
 * way back; they would conclude they had lost the vault. Normalise first, judge after.
 */
export function normalizeMnemonic(raw: string): string {
  return raw.trim().toLowerCase().split(/\s+/u).join(' ');
}

/** One message per cause. "Invalid" alone leaves the reader unable to act on it. */
export function requireValidMnemonic(raw: string): string {
  const phrase = normalizeMnemonic(raw);
  const words = phrase === '' ? [] : phrase.split(' ');
  if (words.length !== PHRASE_WORDS) {
    fail(
      `SERVANDA_MNEMONIC must be ${PHRASE_WORDS} words; got ${words.length}. ` +
        'Whitespace, line breaks and capitalisation do not matter — the word count does.',
    );
  }
  if (!isValidMnemonic(phrase)) {
    fail(
      'SERVANDA_MNEMONIC has 24 words but is not a valid BIP-39 phrase: either a word is not in ' +
        'the wordlist, or the words are right and their order is wrong (the checksum catches ' +
        'both, and cannot tell you which).',
    );
  }
  return phrase;
}

/**
 * `Number.parseInt` reads a prefix: "1.9" is 1 and "2x" is 2, silently. The index is part of the
 * derivation path, so a silently-different index is a silently-different persona.
 */
export function personaIndex(env: Env): number {
  const raw = (env['SERVANDA_INDEX'] ?? '0').trim();
  if (!/^\d+$/u.test(raw)) fail(`SERVANDA_INDEX must be a non-negative integer; got ${JSON.stringify(raw)}`);
  const index = Number(raw);
  if (index > MAX_PERSONA_INDEX) {
    fail(`SERVANDA_INDEX must be at most ${MAX_PERSONA_INDEX} (SLIP-0010 hardened indices are 31-bit)`);
  }
  return index;
}

function printPersona(io: InitIo, heading: string, dir: string, personaId: string, path: string, label: string): void {
  io.out(`\n${heading} ${dir}\n`);
  io.out(`Persona   ${personaId}\n`);
  io.out(`Path      ${path}\n`);
  io.out(`Label     ${label}\n`);
}

/**
 * Add a persona to a vault that already exists.
 *
 * USAGE.md §1 documents this ("other personas from the same seed") and §4 documents selecting
 * between them with SERVANDA_PERSONA, but the only thing that can put a persona in a vault is
 * this program, and it used to refuse every vault it had already made. Both paragraphs described
 * something no command could reach.
 *
 * The phrase is required and not optional politeness: the vault stores persona private keys, not
 * the seed they came from, so there is nothing here to derive a sibling from.
 */
function addPersona(env: Env, io: InitIo, dir: string, passphrase: string, index: number, label: string): void {
  const supplied = env['SERVANDA_MNEMONIC'];
  if (supplied === undefined) {
    fail(
      `a vault already exists at ${dir}.\n` +
        'To ADD a persona to it, supply SERVANDA_MNEMONIC — the vault holds persona keys, not the ' +
        'seed they came from, so siblings can only be derived from the phrase you wrote down.\n' +
        'To create a SEPARATE vault, point SERVANDA_VAULT somewhere else.',
    );
  }
  const seed = mnemonicToSeed(requireValidMnemonic(supplied));

  let vault: Vault;
  try {
    vault = Vault.open({ dir, passphrase });
  } catch (err) {
    fail(openFailure(dir, err));
  }

  const existing = vault.listPersonaIds().map((id) => vault.getPersona(id));

  // A different-but-valid phrase would add a persona nobody can restore alongside the others:
  // replaying either phrase on a new machine would rebuild half the vault. Refuse rather than
  // let one vault quietly become two seeds.
  const fromThisSeed = existing.some(
    (p) => derivePersona(seed, p.persona_index).personaId === p.persona_id,
  );
  if (existing.length > 0 && !fromThisSeed) {
    fail(
      "SERVANDA_MNEMONIC is a valid phrase, but it is not the phrase this vault's personas came " +
        'from. Adding it would leave one vault holding two seeds, and no single phrase could ' +
        'restore it.',
    );
  }

  const persona = derivePersona(seed, index);
  const clash = existing.find((p) => p.persona_id === persona.personaId);
  if (clash) fail(`persona index ${index} is already in this vault, labelled "${clash.label}"`);
  if (existing.some((p) => p.label === label)) {
    fail(`label "${label}" is already used in this vault; a label is how a persona is selected, so it has to be unique`);
  }

  vault.putPersona({
    persona_id: persona.personaId,
    persona_index: persona.personaIndex,
    label,
    scope_kind: 'personal',
    org_root: null,
    private_key: persona.privateKey,
    created_at: vault.now(),
  });

  printPersona(io, 'Persona added to vault at', dir, persona.personaId, persona.path, label);
  io.out('\nAdded to the existing vault. Same phrase, same keys — always.\n');
}

/**
 * Shared so `servanda-init` and `servanda-node` name the same failure the same way.
 *
 * The underlying sentence is passed through rather than rewritten. `unwrapWithPassphrase`
 * already says both what to do (retry — there is no lockout) and what the other possibility is
 * (an altered keyset, whose last good copy is in the vault's git history), and a friendlier
 * paraphrase here would only throw those away. What was missing was never the wording; it was
 * that the exception reached the top of the process as a stack trace.
 */
export function openFailure(dir: string, err: unknown): string {
  return `cannot open the vault at ${dir}: ${err instanceof Error ? err.message : String(err)}`;
}

function createVault(env: Env, io: InitIo, dir: string, passphrase: string, index: number, label: string): void {
  const supplied = env['SERVANDA_MNEMONIC'];
  const mnemonic = supplied === undefined ? generateRootMnemonic() : requireValidMnemonic(supplied);
  const persona = derivePersona(mnemonicToSeed(mnemonic), index);

  // Argon2id at the desktop profile is seconds of one core with nothing on stdout. Said before
  // the wait, it is a parameter choice; said after, it was a hang.
  io.log('Deriving the vault key (Argon2id — seconds, and about a gigabyte of memory)…\n');

  let vault: Vault;
  try {
    vault = Vault.create({ dir, passphrase, author: { name: 'servanda', email: 'servanda@localhost' } });
  } catch (err) {
    fail(`cannot create a vault at ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  vault.putPersona({
    persona_id: persona.personaId,
    persona_index: persona.personaIndex,
    label,
    scope_kind: 'personal',
    org_root: null,
    private_key: persona.privateKey,
    created_at: vault.now(),
  });

  printPersona(io, 'Vault created at', dir, persona.personaId, persona.path, label);

  if (supplied !== undefined) {
    io.out('\nDerived from the phrase you supplied. Same phrase, same keys — always.\n');
    return;
  }

  // Printed once and never written down by the program. ADR-0014: this phrase, an org
  // re-attestation, or an external binding proof are the only ways back — a persona with none of
  // them is unrecoverable by design, which is a property rather than an oversight.
  io.out('\n─────────────────────────────────────────────────────────────────────\n');
  io.out('RECOVERY PHRASE — write it down now. It is shown once and stored nowhere.\n');
  io.out('─────────────────────────────────────────────────────────────────────\n');
  const words = mnemonic.split(' ');
  for (let i = 0; i < words.length; i += 6) {
    io.out(`  ${words.slice(i, i + 6).join(' ')}\n`);
  }
  io.out('─────────────────────────────────────────────────────────────────────\n');
  io.out('Anyone holding these words holds every persona derived from them.\n');
  io.out('Losing them and the passphrase together loses the vault.\n\n');
}

export function runInit(env: Env, io: InitIo): void {
  const dir = env['SERVANDA_VAULT'];
  const passphrase = env['SERVANDA_PASSPHRASE'];
  if (!dir) fail('SERVANDA_VAULT is required (the directory to create the vault in)');
  if (!passphrase) {
    fail(
      'SERVANDA_PASSPHRASE is required.\n' +
        'M-16: a device key must never be the sole custodian of the vault content key, so a ' +
        'passphrase is not optional — without it, losing the device loses the vault.',
    );
  }

  const index = personaIndex(env);
  const label = env['SERVANDA_LABEL'] ?? 'personal';

  if (existsSync(join(dir, VAULT_MARKER))) {
    addPersona(env, io, dir, passphrase, index, label);
    return;
  }
  // A directory with a `.git` and no vault marker is somebody's repository, not a vault of
  // theirs. Saying "a vault already exists" there sends them looking for one that is not there;
  // `Vault.create` has the true sentence and this pre-check used to hide it.
  if (existsSync(join(dir, '.git'))) {
    fail(
      `refusing to create a vault inside an existing git repository: ${dir}\n` +
        '(there is no servanda vault here — the vault is its own repository, and taking this one ' +
        "over would sweep its owner's uncommitted work into the first vault commit)",
    );
  }
  if (existsSync(dir) && !statSync(dir).isDirectory()) {
    fail(`SERVANDA_VAULT must be a directory; ${dir} is a file`);
  }

  createVault(env, io, dir, passphrase, index, label);
}

function main(): void {
  try {
    runInit(process.env, {
      out: (t) => process.stdout.write(t),
      log: (t) => process.stderr.write(t),
    });
  } catch (err) {
    if (err instanceof InitError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) main();
