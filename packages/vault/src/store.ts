import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, relative, sep } from 'node:path';
import { decryptContent, encryptContent, utf8 } from '@servanda/crypto';

/**
 * At-rest encryption for every vault record (§9.3: XChaCha20-Poly1305 under the content key).
 *
 * Everything the vault holds is encrypted, including edges and assertion chains. They contain
 * no plaintext (M-7) but they do carry who-owes-whom, which is exactly the metadata a stolen
 * disk should not yield. Retention (M-15) is therefore a matter of deleting the commitment
 * record while keeping the edge record — not of one being encrypted and the other not.
 */

export interface SealedRecord {
  v: 'servanda/0.2';
  type: 'vault_record';
  kind: string;
  nonce: string;
  ciphertext: string;
}

const HEX_ID = /^[0-9a-f]{1,128}$/;

/** Every id used as a path segment is a hex digest or public key — enforced, not assumed. */
export function assertHexId(id: string, what: string): void {
  if (!HEX_ID.test(id)) throw new TypeError(`${what} must be lowercase hex, got: ${id}`);
}

/**
 * A record could not be opened, and WHICH record it was.
 *
 * The AEAD's failure is one bit — `invalid tag` — and that is what a person used to see, with no
 * path, on a day when a file was half-written or a sync tool had been at the directory. One
 * damaged record takes down the whole listing that walks over it, so "invalid tag" was the entire
 * account of an empty register. The bit cannot be improved on cryptographically; naming the file
 * and the reachable causes can, and that is the difference between a vault to repair and a vault
 * to give up on.
 */
export class SealedRecordError extends Error {
  override name = 'SealedRecordError';
  /** Vault-relative, because that is the form a person can act on and it leaks no home directory. */
  readonly record: string;
  constructor(record: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.record = record;
  }
}

/**
 * Every file this code writes into a vault is `<lowercase hex>.json` or one of a handful of fixed
 * lowercase names. Nothing else in the directory was put there by Servanda.
 *
 * The names that break the rule are not hypothetical: Dropbox and iCloud resolve a two-machine
 * write by leaving `<name> (Someone's conflicted copy 2026-08-01).json` beside the original, and
 * editors leave `edge 2.json`. Both land in a records directory, both are enumerated, and both
 * fail to decrypt — the AAD binds the path, so a copy under a different name is not the record.
 */
const RECORD_FILE_NAME = /^[0-9a-z_-]+\.json$/;

/** A stray file inside a records directory, named so the person knows what to move where. */
export class StrayVaultFile extends Error {
  override name = 'StrayVaultFile';
}

/**
 * Write through a temporary file and rename over the destination.
 *
 * `writeFileSync` to the destination is not one operation: it truncates, then writes. A power
 * loss, a full disk or a killed process between the two leaves a file that is half a record —
 * which is unopenable, and which for an overwrite (`meta.json`, `keyset.json`) has destroyed the
 * good copy that was there a moment ago. `keyset.json` half-written is the whole vault.
 *
 * `rename(2)` within a directory is atomic: a reader sees the old bytes or the new ones, never a
 * prefix of the new ones. The temporary is dot-prefixed so a leftover from a crash is ignored by
 * `listFiles` rather than enumerated as a record.
 */
function writeAtomic(path: string, data: string): void {
  const tmp = join(dirname(path), `.servanda-tmp-${basename(path)}-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tmp, data, 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    discard(tmp);
    throw err;
  }
}

/**
 * The same, for a write that must fail if the destination exists.
 *
 * `wx` gives exclusivity but not atomicity, and an append-only assertion chain needs both: a torn
 * `0003.json` occupies the sequence number forever, so the loss is permanent in a structure whose
 * entire promise is that nothing is lost. `link(2)` is the primitive that has both — it fails with
 * EEXIST if the destination exists and publishes a fully-written file when it does not.
 */
function linkAtomic(path: string, data: string): void {
  const tmp = join(dirname(path), `.servanda-tmp-${basename(path)}-${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tmp, data, 'utf8');
    linkSync(tmp, path);
  } finally {
    discard(tmp);
  }
}

/**
 * Remove a temporary, and never be the reason the caller hears the wrong thing.
 *
 * Cleanup runs on the failure path, where an exception from the cleanup REPLACES the exception
 * that caused it — the disk filled up and the person is told the tidy-up failed. `force` only
 * covers a missing file; a read-only or permission-denied directory still throws. A leftover
 * dot-file is ignored by `listFiles` and swept by the next successful write, which is a much
 * smaller problem than an unreadable error message.
 */
function discard(tmp: string): void {
  try {
    rmSync(tmp, { force: true });
  } catch {
    // Nothing to do about it, and nothing worth saying over the top of the real error.
  }
}

/**
 * The AEAD's additional authenticated data: where this record lives, and what it claims to be.
 *
 * Without it, a sealed record was portable. Every record in a vault is sealed under ONE content
 * key, so a file lifted out of persona A's directory and dropped into persona B's decrypted
 * perfectly and was read as B's — a §5.3 M-5 org-context mix performed by somebody who cannot
 * decrypt anything, needs no key at all, and leaves the ciphertext untouched. The vault's own
 * path checks (`assertHexId`, `requirePersona`) all run against the path the ATTACKER chose, so
 * every one of them passed.
 *
 * The binding is the vault-relative path plus the declared `kind`. The path carries the persona
 * id, the record class and the record's own id, which is exactly the set of facts a relocation
 * has to change. `kind` is in because it is the one claim the record makes about itself that the
 * path does not repeat.
 *
 * **It is recomputed, never stored.** A binding travelling beside its ciphertext would be
 * relocated with it. Separators are normalised so that a vault is portable between platforms
 * while a record is not portable within one.
 */
export function recordBinding(vaultDir: string, path: string, kind: string): Uint8Array {
  const rel = relative(vaultDir, path).split(sep).join('/');
  if (rel.startsWith('..')) {
    throw new TypeError(`refusing to seal outside the vault: ${rel}`);
  }
  return utf8(`servanda/0.2 vault-record\u0000${kind}\u0000${rel}`);
}

export function sealRecord(
  contentKey: Uint8Array,
  kind: string,
  value: unknown,
  binding: Uint8Array,
): SealedRecord {
  const blob = encryptContent(contentKey, utf8(JSON.stringify(value)), binding);
  return { v: 'servanda/0.2', type: 'vault_record', kind, nonce: blob.nonce, ciphertext: blob.ciphertext };
}

export function openRecord<T>(contentKey: Uint8Array, record: SealedRecord, binding: Uint8Array): T {
  const bytes = decryptContent(
    contentKey,
    { nonce: record.nonce, ciphertext: record.ciphertext },
    binding,
  );
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export function writeSealed(
  vaultDir: string,
  path: string,
  contentKey: Uint8Array,
  kind: string,
  value: unknown,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const record = sealRecord(contentKey, kind, value, recordBinding(vaultDir, path, kind));
  writeAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Write only if the path does not exist, decided by the filesystem rather than by us.
 *
 * `existsSync` followed by a write is two operations, and an append-only chain is exactly where
 * the gap between them matters: two processes on one vault — a CLI and a running node, or two
 * terminals — both count the same N files, both pick `000N.json`, and the second silently
 * overwrites the first's assertion. Both wrote a signed statement; only one survives, and the
 * chain that remains is well-formed, so nothing downstream can tell.
 *
 * `link` makes the check and the publish one syscall. The loser gets EEXIST and can be told the
 * truth. (`wx` did the same job until the write also had to be all-or-nothing; see `linkAtomic`.)
 */
export function writeSealedExclusive(
  vaultDir: string,
  path: string,
  contentKey: Uint8Array,
  kind: string,
  value: unknown,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const record = sealRecord(contentKey, kind, value, recordBinding(vaultDir, path, kind));
  linkAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
}

export function readSealed<T>(vaultDir: string, path: string, contentKey: Uint8Array): T {
  const rel = relative(vaultDir, path).split(sep).join('/');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new SealedRecordError(rel, `${rel} could not be read from the vault`, { cause });
  }

  let record: SealedRecord;
  try {
    record = JSON.parse(raw) as SealedRecord;
  } catch (cause) {
    // The shape a half-finished write leaves. Said plainly, because the alternative reading — that
    // the vault is destroyed — is the one a person arrives at on their own, and it is wrong: every
    // other record in the directory is intact and this one is still in git history.
    throw new SealedRecordError(
      rel,
      `${rel} is not readable as JSON, so it was written only partly — a power loss, a full disk ` +
        `or a killed process during a write does this. No other record is affected. The last good ` +
        `copy is in this vault's git history; move this file out of the vault to read the rest.`,
      { cause },
    );
  }
  if (typeof record?.ciphertext !== 'string' || typeof record?.nonce !== 'string') {
    throw new SealedRecordError(
      rel,
      `${rel} is valid JSON but not a Servanda sealed record (no nonce and ciphertext).`,
    );
  }

  try {
    // The binding uses the path the record was FOUND at and the `kind` the record DECLARES, so a
    // relocated record fails on the path and a re-labelled one fails on the kind.
    return openRecord<T>(contentKey, record, recordBinding(vaultDir, path, record.kind));
  } catch (cause) {
    // One bit comes back from the AEAD and it cannot say which of these it was. Listing them is
    // not hedging: each has a different first move, and the first two are things the person did
    // and can undo, which is the case worth naming before "your data is gone".
    throw new SealedRecordError(
      rel,
      `${rel} did not open. A sealed record is bound to the exact place it lives, so this is ` +
        `either: the file was moved, renamed or copied inside the vault (put it back at ${rel}); ` +
        `or its bytes were altered on disk; or this vault's records were sealed under a different ` +
        `content key than the one that just opened keyset.json. Every other record is unaffected.`,
      { cause },
    );
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/**
 * Enumerate a records directory, refusing anything Servanda did not write.
 *
 * Refusing rather than skipping. A sync conflict copy means two machines wrote the same record and
 * the tool picked a winner — silently ignoring the loser would hide that a promise the owner made
 * on one machine is now only in a file nothing reads. The name is in the message because in the
 * cloud-sync case the name IS the diagnosis.
 */
export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .sort();
  for (const name of names) {
    if (!RECORD_FILE_NAME.test(name)) {
      throw new StrayVaultFile(
        `${join(dir, name)} is not a name Servanda writes. A cloud-sync conflict copy, an editor ` +
          `backup or a hand-made copy left inside the vault will do this, and it cannot be read ` +
          `where it lies — a record is sealed to its own path. Move it out of the vault directory ` +
          `and open again; if it is the only copy of something, keep it somewhere safe first.`,
      );
    }
  }
  return names;
}

export function listDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export function removeFile(path: string): boolean {
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
