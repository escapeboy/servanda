import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';
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
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
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
 * `wx` makes the check and the write one syscall. The loser gets EEXIST and can be told the truth.
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
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

export function readSealed<T>(vaultDir: string, path: string, contentKey: Uint8Array): T {
  const record = JSON.parse(readFileSync(path, 'utf8')) as SealedRecord;
  // The binding uses the path the record was FOUND at and the `kind` the record DECLARES, so a
  // relocated record fails on the path and a re-labelled one fails on the kind.
  return openRecord<T>(contentKey, record, recordBinding(vaultDir, path, record.kind));
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
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
