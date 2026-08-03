import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  type Argon2idParams,
  type ContentKeySet,
  type WrappedKey,
  ARGON2ID_PARAMS,
  assertM16,
  commitmentHash,
  edgeIdBindsBody,
  generateContentKey,
  hashCanonical,
  kdfProfileOf,
  rewrapPassphrase,
  sealContentKey,
  unwrapWithDevice,
  unwrapWithPassphrase,
  wrapForDevice,
  wrapForPassphrase,
} from '@servanda/crypto';
import type {
  Assertion,
  Attestation,
  Commitment,
  DomainAnchor,
  Edge,
  Expectation,
  Publish,
  Revocation,
  Rotation,
} from '@servanda/types';
import { PROTOCOL_VERSION } from '@servanda/types';
import { assertVaultRepo, commitAll, initVaultRepo, VAULT_MARKER } from './git.js';
import {
  DEFAULT_RETENTION_DAYS,
  type EdgeMeta,
  type OrderingKey,
  type OutboxDelivery,
  OutboxItem,
  type OutboxItemInput,
  type PendingExtraction,
  type PersonaRecord,
  type RetentionPolicy,
} from './records.js';
import {
  assertHexId,
  listDirs,
  listFiles,
  readJson,
  readSealed,
  removeFile,
  writeJson,
  writeSealed,
  writeSealedExclusive,
} from './store.js';

/**
 * @servanda/vault — the sovereign local store (L0).
 *
 * Three properties define it:
 *  - **Encrypted at rest.** One random content key (§9.3), wrapped per device and by a
 *    passphrase. The keyset goes through `sealContentKey`, which refuses a device-only
 *    custody arrangement (M-16).
 *  - **Git-backed.** The vault directory is its own repository; every mutating call commits.
 *  - **Persona-scoped.** Every read takes a persona and reads only that persona's subtree.
 *    There is exactly one cross-persona read, named below, and it returns no content (M-5).
 *
 * M-10: nothing here opens a socket. The vault is fully functional with no network, no
 * server, and no second participant.
 */

export class VaultError extends Error {
  override name = 'VaultError';
}

/** Raised when a read is attempted with the wrong persona's handle (§5.3 M-5). */
export class ScopeViolation extends VaultError {
  override name = 'ScopeViolation';
}

export interface VaultAuthor {
  name: string;
  email: string;
}

export interface VaultCreateOptions {
  dir: string;
  /**
   * Required. M-16 is structural: a vault cannot be created whose content key is held only by
   * device keys, because there is no code path that builds a keyset without this.
   */
  passphrase: string;
  deviceKeys?: { label: string; keyHex: string }[];
  author?: VaultAuthor;
  retentionDays?: number;
  now?: () => Date;
  /**
   * §9.3 profile for the passphrase wrap. Defaults to the desktop point (m = 1 GiB), which costs
   * seconds per open — deliberately, since memory is the only parameter that cuts an attacker's
   * parallelism. A constrained device passes `ARGON2ID_CONSTRAINED`, and so does every test in
   * this repository: a suite that stood up hundreds of vaults at the desktop profile would take
   * hours and teach nothing the constrained one does not.
   */
  kdf?: Argon2idParams;
}

export interface VaultOpenOptions {
  dir: string;
  passphrase?: string;
  deviceKey?: { label?: string; keyHex: string };
  now?: () => Date;
}

interface VaultDescriptor {
  v: typeof PROTOCOL_VERSION;
  type: 'vault_descriptor';
  created_at: string;
}

const DEFAULT_AUTHOR: VaultAuthor = { name: 'servanda', email: 'vault@servanda.local' };

/**
 * §5.3 M-5. The single named escape hatch that may read across personas. It is a list of one
 * so that "how many places mix org contexts?" has an answer a test can assert.
 */
export const CROSS_PERSONA_APIS = ['listOrderingKeysAcrossPersonas'] as const;

/** A device key as its holder has it: the label this vault knows it by, and the key itself. */
export interface DeviceKey {
  label: string;
  keyHex: string;
}

export interface RekeyOptions {
  /** Verified against the current keyset first, then used to wrap the NEW content key. */
  passphrase: string;
  /**
   * The COMPLETE set of device keys the vault should have afterwards. Every device wrap not
   * named here stops opening this vault — that omission is the revocation. See `Vault.rekey`
   * for why this is a whole set and not a label to drop.
   */
  deviceKeys?: DeviceKey[];
  /** Defaults to the profile the vault's current passphrase wrap was made at. */
  kdf?: Argon2idParams;
}

export interface RekeyReport {
  /** How many sealed records were opened under the old key and written back under the new one. */
  resealed: number;
  deviceLabelsBefore: string[];
  deviceLabelsAfter: string[];
  /**
   * The commit at which the old content key stopped being this vault's key — and therefore the
   * exact point up to which a revoked credential still reads everything, out of this vault's own
   * git history. See `Vault.rekey` for the full account of what a re-key does not reach.
   */
  commit: string | null;
}

export class Vault {
  readonly dir: string;
  /** Not readonly: `rekey` replaces it, and a stale handle reading with the old key is the bug. */
  private contentKey: Uint8Array;
  private readonly clock: () => Date;

  private constructor(dir: string, contentKey: Uint8Array, clock: () => Date) {
    this.dir = dir;
    this.contentKey = contentKey;
    this.clock = clock;
  }

  static create(opts: VaultCreateOptions): Vault {
    const { dir } = opts;
    if (existsSync(join(dir, VAULT_MARKER))) throw new VaultError(`vault already exists at ${dir}`);
    // `assertVaultRepo` guards every LATER call, and cannot guard this one: it asks whether the
    // directory is the root of its own repo carrying the marker, and creation is what writes the
    // marker. So an existing repository would pass the guard a moment after being taken over —
    // `git config` replacing its owner's identity and the first vault commit sweeping up their
    // uncommitted work through `add -A`.
    if (existsSync(join(dir, '.git'))) {
      throw new VaultError(`refusing to create a vault inside an existing git repository: ${dir}`);
    }
    mkdirSync(dir, { recursive: true });

    const clock = opts.now ?? (() => new Date());
    const contentKey = generateContentKey();
    const wraps: WrappedKey[] = [wrapForPassphrase(contentKey, opts.passphrase, 'passphrase', opts.kdf ?? ARGON2ID_PARAMS)];
    for (const d of opts.deviceKeys ?? []) wraps.push(wrapForDevice(contentKey, d.keyHex, d.label));
    // sealContentKey enforces M-16; it is not bypassed and not re-implemented here.
    const keyset = sealContentKey(contentKey, wraps);

    const descriptor: VaultDescriptor = {
      v: PROTOCOL_VERSION,
      type: 'vault_descriptor',
      created_at: clock().toISOString(),
    };
    writeJson(join(dir, VAULT_MARKER), descriptor);
    writeJson(join(dir, 'keyset.json'), keyset);

    const vault = new Vault(dir, contentKey, clock);
    vault.writeRetentionPolicy(opts.retentionDays ?? DEFAULT_RETENTION_DAYS);

    initVaultRepo(dir, opts.author ?? DEFAULT_AUTHOR);
    commitAll(dir, 'chore(vault): initialise vault');
    return vault;
  }

  static open(opts: VaultOpenOptions): Vault {
    const { dir } = opts;
    assertVaultRepo(dir);
    assertSupportedVersion(dir);
    const keyset = readKeyset(dir);
    // M-16 on every open, not only on create. `sealContentKey` proves no code here BUILDS a
    // device-only keyset; it proves nothing about the unsigned JSON file sitting in a directory
    // its owner can write. Deleting the passphrase wrap produced a keyset that satisfied every
    // schema, violated M-16, and opened. Custody is a property a vault has at rest.
    assertM16(keyset.wraps);
    let contentKey: Uint8Array;
    if (opts.passphrase !== undefined) {
      contentKey = unwrapPassphraseOrExplain(dir, keyset, opts.passphrase);
    } else if (opts.deviceKey) {
      contentKey = unwrapWithDevice(keyset, opts.deviceKey.keyHex, opts.deviceKey.label);
    } else {
      throw new VaultError('opening a vault requires a passphrase or a device key');
    }
    return new Vault(dir, contentKey, opts.now ?? (() => new Date()));
  }

  now(): string {
    return this.clock().toISOString();
  }

  /**
   * The §9.3 profile this vault's weakest passphrase wrap was made at, and whether it is behind
   * the current default.
   *
   * Reported rather than acted on. §9.3's "MAY raise" is the owner's to exercise: rewriting key
   * material is not something a caller should discover after the fact, and an open that silently
   * costs six seconds more than the last one is a bug report, not an upgrade.
   */
  kdfProfile(): { m: number; t: number; p: number; behindDefault: boolean } | null {
    const kdf = kdfProfileOf(this.keyset());
    if (!kdf) return null;
    const current = ARGON2ID_PARAMS;
    return { ...kdf, behindDefault: kdf.m * kdf.t * kdf.p < current.m * current.t * current.p };
  }

  /**
   * Re-wrap the passphrase slots at `params`, keeping the content key and every device wrap.
   *
   * This is what makes §9.3's "MAY raise" a permission rather than a sentence: a wrap is opened
   * with its own stored parameters, so before this existed the value a vault was created at was
   * the value for its whole life.
   */
  upgradeKdf(passphrase: string, params: Argon2idParams = ARGON2ID_PARAMS): void {
    const upgraded = rewrapPassphrase(this.keyset(), passphrase, params);
    writeJson(join(this.dir, 'keyset.json'), upgraded);
    this.commit(`chore(vault): re-wrap passphrase at m=${params.m} t=${params.t} p=${params.p}`);
  }

  /** Exposed so the M-16 test can assert on the custody arrangement of a real vault. */
  keyset(): ContentKeySet {
    return readJson<ContentKeySet>(join(this.dir, 'keyset.json'));
  }

  // ── device custody (§1.7, M-16) ─────────────────────────────────────────────────────────

  /** The labels of every device wrap this vault currently carries, in keyset order. */
  deviceKeyLabels(): string[] {
    return this.keyset().wraps.flatMap((w) => (w.kind === 'device' ? [w.label] : []));
  }

  /**
   * Wrap this vault's content key for one more device.
   *
   * Until this existed, `Vault.create`'s `deviceKeys` was the only moment a device could ever be
   * admitted, so adding a phone to a vault made last year was not a thing the library could do.
   *
   * The label must be free, because a label is the whole of how a device is NAMED when custody is
   * withdrawn (`rekey` below). Two devices sharing one label make "which device is this" a
   * question the keyset cannot answer, and the answer matters exactly on the day it is asked.
   */
  addDeviceKey(device: DeviceKey): void {
    const keyset = this.keyset();
    if (keyset.wraps.some((w) => w.kind === 'device' && w.label === device.label)) {
      throw new VaultError(
        `this vault already has a device key labelled ${JSON.stringify(device.label)}. A label is ` +
          `how a device is named when its access is withdrawn, so two devices cannot share one.`,
      );
    }
    const wraps = [...keyset.wraps, wrapForDevice(this.contentKey, device.keyHex, device.label)];
    // Through `sealContentKey`, so M-16 is re-checked against the arrangement being written and
    // not merely against the one this process started with.
    writeJson(join(this.dir, 'keyset.json'), sealContentKey(this.contentKey, wraps));
    this.commit(`feat(keyset): add device wrap ${device.label}`);
  }

  /**
   * Replace the content key, re-seal every record under the new one, and rebuild the keyset from
   * the credentials named here — and NOTHING else.
   *
   * ## Why there is no `removeDeviceKey`
   *
   * Because it would be a lie. Deleting a wrap from `keyset.json` removes nothing from the person
   * who has the laptop: they hold the whole directory, including the keyset as it was and every
   * ciphertext it opened. A vault is a set of files, not a service that can refuse a request. The
   * only thing that actually withdraws access is a new content key that the old credential never
   * wrapped, and that is what this does.
   *
   * ## What this DOES protect, exactly
   *
   * Records written **after** the re-key. Nothing else.
   *
   * ## What it does NOT protect, exactly — three separate holes, none of them closable here
   *
   * 1. **Everything written before the theft is already gone.** The thief copied the directory;
   *    re-keying this copy does not reach theirs. No re-key, here or anywhere, recovers a secret
   *    that has already been read.
   * 2. **This vault's own git history hands the old key back.** `.git` retains the previous
   *    `keyset.json` — device wrap included — and every pre-re-key ciphertext. Anyone holding a
   *    revoked device key who can read this directory at any later date recovers the OLD content
   *    key from history and reads the vault as of the last commit before the re-key, even though
   *    every file in the working tree has been rewritten. History is not purged, deliberately:
   *    the vault's recoverable history is a property it is built on (§4.2 append-only chains rest
   *    on it), any clone or backup keeps its own copy anyway, and destroying it would buy a
   *    guarantee against one adversary by removing a guarantee relied on against several.
   * 3. **The passphrase is a shared credential.** A device that was trusted enough to hold a wrap
   *    was usually trusted enough to have seen the passphrase typed. This function withdraws a
   *    device key; it cannot withdraw a memory. Change the passphrase in the same breath by
   *    passing a different one — the new keyset is built from what is passed here, not from what
   *    was there.
   *
   * So: this is a forward boundary, not an eraser. If the promise a caller needs is "they can
   * never read what they already had", the honest answer is that no code in this repository can
   * give it, and persona rotation (§1.7) — not a re-key — is what limits the damage of an
   * identity that is already in someone else's hands.
   *
   * ## Why `deviceKeys` is the complete new set rather than a label to drop
   *
   * Because the vault holds each device's WRAP, never its key. A wrap cannot be re-made for a
   * device whose key material the caller does not have, so "remove device B, keep A and C" is not
   * expressible without A's and C's keys in hand — and an API that accepted a label would have to
   * discover that at the point where it had already thrown the old key away. Naming the survivors
   * makes the physical constraint visible before anything is written, and makes forgetting a
   * device a loud mistake rather than a quiet one.
   *
   * The passphrase is verified against the CURRENT keyset before anything moves, so a typo cannot
   * silently re-key the vault to a passphrase nobody knows. That costs one extra derivation and it
   * buys the difference between a failed call and an unopenable vault.
   */
  rekey(opts: RekeyOptions): RekeyReport {
    const before = this.keyset();
    // Refuse before touching anything if this is not this vault's passphrase. Without the check
    // the call would succeed and write a keyset whose only passphrase wrap opens with a string
    // its owner mistyped once.
    try {
      unwrapWithPassphrase(before, opts.passphrase);
    } catch (cause) {
      throw new VaultError(
        `refusing to re-key: the passphrase given does not open this vault's current keyset. ` +
          `Re-keying builds the new keyset from what is passed here, so proceeding on a mistyped ` +
          `passphrase would leave a vault nobody can open.`,
        { cause },
      );
    }

    // Read and decrypt EVERYTHING first. A record that will not open under the old key is a vault
    // that must not be half re-keyed — the failure has to happen while the old keyset is still the
    // one on disk and every file is still readable.
    const records = this.sealedRecordPaths();
    const opened = records.map((path) => {
      const raw = readJson<{ kind: string }>(path);
      return { path, kind: raw.kind, value: readSealed<unknown>(this.dir, path, this.contentKey) };
    });

    const contentKey = generateContentKey();
    // The binding is (vault-relative path, kind) and neither moves, so each record is re-sealed
    // into exactly the place and role it already had.
    for (const r of opened) writeSealed(this.dir, r.path, contentKey, r.kind, r.value);

    const wraps: WrappedKey[] = [
      wrapForPassphrase(
        contentKey,
        opts.passphrase,
        'passphrase',
        // The vault's CURRENT profile by default. A re-key is about custody, and silently moving a
        // constrained-device vault to the desktop profile would make the next open cost seconds it
        // did not cost before — a change its owner did not ask for while asking for another one.
        opts.kdf ?? profileOf(before),
      ),
    ];
    for (const d of opts.deviceKeys ?? []) wraps.push(wrapForDevice(contentKey, d.keyHex, d.label));

    // Records first, keyset last, one commit at the end: a crash between them leaves an
    // uncommitted working tree that `git -C <dir> checkout .` restores whole, because the last
    // commit is still the consistent pre-re-key state.
    writeJson(join(this.dir, 'keyset.json'), sealContentKey(contentKey, wraps));
    const sha = commitAll(this.dir, `chore(vault): re-key, ${opened.length} records re-sealed`);

    this.contentKey = contentKey;
    return {
      resealed: opened.length,
      deviceLabelsBefore: before.wraps.flatMap((w) => (w.kind === 'device' ? [w.label] : [])),
      deviceLabelsAfter: wraps.flatMap((w) => (w.kind === 'device' ? [w.label] : [])),
      commit: sha,
    };
  }

  /**
   * Every sealed record in the vault, found by what the file SAYS it is rather than by a list of
   * the record kinds this class happens to know about today.
   *
   * A hardcoded list is the failure this repository already has a note about in
   * `gates/must-coverage.sh`: it goes stale the first time the truth moves, silently and in the
   * direction nobody is watching. A record kind added next year and missed here would be left
   * sealed under a content key that no longer exists — a vault that opens and cannot read part of
   * itself, discovered long after the re-key.
   */
  private sealedRecordPaths(): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(this.dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('.')) continue;
      const path = join(entry.parentPath, entry.name);
      if (relative(this.dir, path).split(sep)[0] === '.git') continue;
      let raw: unknown;
      try {
        raw = readJson<unknown>(path);
      } catch (cause) {
        throw new VaultError(
          `refusing to re-key: ${relative(this.dir, path)} is not readable JSON, so this vault ` +
            `cannot be read whole and re-sealing part of it would leave the rest unopenable.`,
          { cause },
        );
      }
      if ((raw as { type?: string } | null)?.type === 'vault_record') found.push(path);
    }
    return found;
  }

  /**
   * A commit message names identifiers, never content.
   *
   * `.git` is not encrypted and `git log` needs no key, so every message here is readable by
   * anyone who can read the directory — which is the threat the sealing exists for. Naming a
   * record by a truncated hex id reveals that it exists, and the directory layout reveals that
   * anyway. Naming it by what it SAYS gives away the thing the vault was holding: the persona
   * label was a string its owner typed, and an assertion's state published the whole state
   * machine of a commitment, dated, to a reader with no key at all.
   */
  private commit(message: string): void {
    commitAll(this.dir, message);
  }

  // ── paths ───────────────────────────────────────────────────────────────────────────────

  private personaDir(persona: string): string {
    assertHexId(persona, 'persona_id');
    return join(this.dir, 'personas', persona);
  }

  private requirePersona(persona: string): string {
    const dir = this.personaDir(persona);
    if (!existsSync(join(dir, 'persona.json'))) {
      throw new ScopeViolation(`no such persona in this vault: ${persona}`);
    }
    return dir;
  }

  // ── personas (§1.2) ─────────────────────────────────────────────────────────────────────

  /**
   * §1.2: a label is one of the two ways to name a persona, so two personas cannot share one.
   *
   * The guarantee has to live here rather than in `servanda-init`, which is where it started.
   * `client-local`'s `openRegister` resolves `SERVANDA_PERSONA` with
   * `p.persona_id === wanted || p.label === wanted` and takes the first match — so a duplicate
   * label does not fail, it silently opens whichever persona happens to be enumerated first, and
   * the person reads a register that is not the one they asked for. A CLI-only guard leaves that
   * reachable through the published library, including from this repo's own fixtures.
   *
   * Re-putting the SAME persona is an update, not a collision — that is how a record is amended.
   */
  putPersona(record: PersonaRecord): void {
    const dir = this.personaDir(record.persona_id);
    for (const id of this.listPersonaIds()) {
      if (id === record.persona_id) continue;
      if (this.getPersona(id).label === record.label) {
        throw new ScopeViolation(
          `label ${JSON.stringify(record.label)} is already used by persona ${id.slice(0, 12)}; ` +
            `a label names a persona, so two personas cannot share one`,
        );
      }
    }
    writeSealed(this.dir, join(dir, 'persona.json'), this.contentKey, 'persona', record);
    this.commit(`feat(persona): add ${record.persona_id.slice(0, 12)}`);
  }

  getPersona(persona: string): PersonaRecord {
    const dir = this.requirePersona(persona);
    return readSealed<PersonaRecord>(this.dir, join(dir, 'persona.json'), this.contentKey);
  }

  listPersonaIds(): string[] {
    return listDirs(join(this.dir, 'personas')).filter((p) =>
      existsSync(join(this.dir, 'personas', p, 'persona.json')),
    );
  }

  // ── commitments (§3.1) ──────────────────────────────────────────────────────────────────

  putCommitment(persona: string, commitment: Commitment): void {
    const dir = this.requirePersona(persona);
    assertHexId(commitment.owner, 'commitment.owner');
    const hash = commitmentKey(commitment);
    writeSealed(this.dir, join(dir, 'commitments', `${hash}.json`), this.contentKey, 'commitment', commitment);
    this.commit(`feat(commitment): record ${hash.slice(0, 12)}`);
  }

  /** Reads only within `persona`'s subtree — a hash belonging to another persona is not found. */
  getCommitment(persona: string, commitmentHash: string): Commitment | null {
    const dir = this.requirePersona(persona);
    assertHexId(commitmentHash, 'commitment_hash');
    const path = join(dir, 'commitments', `${commitmentHash}.json`);
    if (!existsSync(path)) return null;
    return readSealed<Commitment>(this.dir, path, this.contentKey);
  }

  listCommitments(persona: string): { hash: string; commitment: Commitment }[] {
    const dir = this.requirePersona(persona);
    return listFiles(join(dir, 'commitments')).map((f) => ({
      hash: f.replace(/\.json$/, ''),
      commitment: readSealed<Commitment>(this.dir, join(dir, 'commitments', f), this.contentKey),
    }));
  }

  /**
   * M-15: delete the plaintext, keep the proof. Returns true when a record was removed.
   * The edge and its assertion chain are untouched by construction — they live elsewhere.
   *
   * **Removed from the working tree, not from history.** This vault is a git repository, so the
   * commit below records the deletion and the sealed blob remains reachable at the parent commit,
   * under the same content key it was always sealed with. Anyone holding the passphrase and the
   * repository can still read it. See the note in `retention.ts` for why that is structural
   * rather than an oversight, and §5.4 for what M-15 therefore does and does not promise.
   */
  deleteCommitmentPlaintext(persona: string, commitmentHash: string): boolean {
    const dir = this.requirePersona(persona);
    assertHexId(commitmentHash, 'commitment_hash');
    const removed = removeFile(join(dir, 'commitments', `${commitmentHash}.json`));
    if (removed) this.commit(`chore(retention): delete plaintext ${commitmentHash.slice(0, 12)}`);
    return removed;
  }

  // ── expectations (§3.3) ─────────────────────────────────────────────────────────────────

  putExpectation(persona: string, id: string, expectation: Expectation): void {
    const dir = this.requirePersona(persona);
    assertHexId(id, 'expectation_id');
    writeSealed(this.dir, join(dir, 'expectations', `${id}.json`), this.contentKey, 'expectation', expectation);
    this.commit(`feat(expectation): record ${id.slice(0, 12)}`);
  }

  getExpectation(persona: string, id: string): Expectation | null {
    const dir = this.requirePersona(persona);
    assertHexId(id, 'expectation_id');
    const path = join(dir, 'expectations', `${id}.json`);
    if (!existsSync(path)) return null;
    return readSealed<Expectation>(this.dir, path, this.contentKey);
  }

  listExpectations(persona: string): { id: string; expectation: Expectation }[] {
    const dir = this.requirePersona(persona);
    return listFiles(join(dir, 'expectations')).map((f) => ({
      id: f.replace(/\.json$/, ''),
      expectation: readSealed<Expectation>(this.dir, join(dir, 'expectations', f), this.contentKey),
    }));
  }

  // ── edges + assertion chains (§4.1, §4.2) ───────────────────────────────────────────────

  /**
   * §4.1, both halves, as a storage invariant rather than a caller's duty.
   *
   * The identifier must digest the body it names, and the first body accepted under an
   * identifier is the body — "MUST reject any subsequent edge body bearing the same `edge_id`
   * whose other members differ, with the whole body discarded rather than merged". Only four of
   * the eleven members are inside the preimage, so `closure_policy` — which decides who may
   * close (§4.4) — is unsigned and uncovered, and first-sight binding is all that holds it.
   *
   * It lives here because every route that stores an edge passes through this method: node-local
   * creation, §6.4 reconciliation's refusal to introduce edges, §6.6 recovery, and the inbox.
   * The inbox checks the same two things itself, so that a hostile propose is DISCARDED with a
   * named reason rather than throwing out of ingestion and taking the rest of the batch with it;
   * this is the backstop that makes it unbypassable rather than the place it is reported.
   *
   * Re-storing an identical body is a no-op, not a violation: transports replay.
   */
  putEdge(persona: string, edge: Edge): void {
    if (!edgeIdBindsBody(edge)) {
      throw new VaultError(
        `§4.1: edge_id ${edge.edge_id.slice(0, 12)} is not the digest of this edge body`,
      );
    }
    const held = this.getEdge(persona, edge.edge_id);
    if (held) {
      if (hashCanonical(held as unknown as Record<string, unknown>) !== hashCanonical(edge as unknown as Record<string, unknown>)) {
        throw new VaultError(
          `§4.1: a different body is already bound to edge_id ${edge.edge_id.slice(0, 12)}`,
        );
      }
      return;
    }
    const dir = this.edgeDir(persona, edge.edge_id);
    writeSealed(this.dir, join(dir, 'edge.json'), this.contentKey, 'edge', edge);
    this.commit(`feat(edge): ${edge.edge_id.slice(0, 12)}`);
  }

  private edgeDir(persona: string, edgeId: string): string {
    const dir = this.requirePersona(persona);
    assertHexId(edgeId, 'edge_id');
    return join(dir, 'edges', edgeId);
  }

  getEdge(persona: string, edgeId: string): Edge | null {
    const path = join(this.edgeDir(persona, edgeId), 'edge.json');
    if (!existsSync(path)) return null;
    return readSealed<Edge>(this.dir, path, this.contentKey);
  }

  listEdgeIds(persona: string): string[] {
    const dir = this.requirePersona(persona);
    return listDirs(join(dir, 'edges'));
  }

  /**
   * §4.2: "Nodes MUST retain the full assertion chain (append-only)." Appending is the only
   * mutation offered — there is no update and no delete, and a sequence number is never reused.
   */
  appendAssertion(persona: string, assertion: Assertion): number {
    const dir = join(this.edgeDir(persona, assertion.edge_id), 'assertions');
    const seq = listFiles(dir).length;
    const path = join(dir, `${String(seq).padStart(4, '0')}.json`);
    // Exclusive create: the filesystem decides, not a preceding `existsSync`. Counting the files
    // and then writing is two steps, and a second process on the same vault counts the same N
    // between them — both pick `000N.json` and the later write replaces a signed assertion with
    // another one. The survivor is well-formed, so an append-only chain quietly loses a link.
    try {
      writeSealedExclusive(this.dir, path, this.contentKey, 'assertion', assertion);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new VaultError(`assertion chain is append-only; ${path} already exists`);
      }
      throw err;
    }
    this.commit(`feat(assertion): ${assertion.edge_id.slice(0, 12)}`);
    return seq;
  }

  getAssertions(persona: string, edgeId: string): Assertion[] {
    const dir = join(this.edgeDir(persona, edgeId), 'assertions');
    return listFiles(dir).map((f) => readSealed<Assertion>(this.dir, join(dir, f), this.contentKey));
  }

  // ── edge-local bookkeeping ──────────────────────────────────────────────────────────────

  getEdgeMeta(persona: string, edgeId: string): EdgeMeta {
    const path = join(this.edgeDir(persona, edgeId), 'meta.json');
    if (!existsSync(path)) return { edge_id: edgeId, dismissed: false, plaintext_deleted_at: null };
    return readSealed<EdgeMeta>(this.dir, path, this.contentKey);
  }

  putEdgeMeta(persona: string, meta: EdgeMeta): void {
    const path = join(this.edgeDir(persona, meta.edge_id), 'meta.json');
    writeSealed(this.dir, path, this.contentKey, 'edge_meta', meta);
    this.commit(`chore(edge): meta ${meta.edge_id.slice(0, 12)}`);
  }

  // ── publish records (§5.2) ──────────────────────────────────────────────────────────────

  /**
   * §5.2: only a party to the edge may publish it. The vault refuses to store a publish record
   * signed by a non-party — the store is not a place to smuggle an unenforceable claim into.
   */
  putPublish(persona: string, publish: Publish): void {
    const dir = this.requirePersona(persona);
    const edge = this.getEdge(persona, publish.edge_id);
    if (!edge) throw new VaultError(`cannot publish an edge this vault does not hold: ${publish.edge_id}`);
    if (publish.by !== edge.owner && publish.by !== edge.owed_to) {
      throw new ScopeViolation('§5.2: only a party to the edge may publish it');
    }
    const seq = listFiles(join(dir, 'publish')).length;
    writeSealed(this.dir, 
      join(dir, 'publish', `${String(seq).padStart(4, '0')}.json`),
      this.contentKey,
      'publish',
      publish,
    );
    this.commit(`feat(publish): ${publish.edge_id.slice(0, 12)} → ${publish.scope.slice(0, 12)}`);
  }

  listPublishRecords(persona: string): Publish[] {
    const dir = this.requirePersona(persona);
    return listFiles(join(dir, 'publish')).map((f) =>
      readSealed<Publish>(this.dir, join(dir, 'publish', f), this.contentKey),
    );
  }

  // ── rotations (§1.7) ────────────────────────────────────────────────────────────────────

  /**
   * §1.7: "the signature by `old` is what transfers continuity: verifiers MUST treat `new` as the
   * successor for all open edges of `old`."
   *
   * There was nowhere to put one. `resolveSuccessor` was written, was correct, and had no
   * production caller, and the vault had no record type — so a counterparty holding a perfectly
   * valid rotation statement could do nothing with it. §1.7 lists rotation as one of two seedless
   * recovery paths, and the path existed only on paper: the persona survived a lost device by
   * still holding the seed, which is to say by not needing the rotation.
   *
   * Keyed by `new` rather than by `old`. A key may be rotated away from only once — a second
   * rotation from the same `old` is the FORK `resolveSuccessor` refuses to choose between — so
   * keying by `old` would silently overwrite one of the two statements that make it a fork, and
   * the vault would hide the ambiguity the resolver exists to report.
   */
  putRotation(persona: string, rotation: Rotation): void {
    const dir = this.requirePersona(persona);
    assertHexId(rotation.new, 'rotation.new');
    assertHexId(rotation.old, 'rotation.old');
    writeSealed(
      this.dir,
      join(dir, 'rotations', `${rotation.new}.json`),
      this.contentKey,
      'rotation',
      rotation,
    );
    this.commit(`feat(rotation): ${rotation.old.slice(0, 12)} → ${rotation.new.slice(0, 12)}`);
  }

  listRotations(persona: string): Rotation[] {
    const dir = this.requirePersona(persona);
    return listFiles(join(dir, 'rotations')).map((f) =>
      readSealed<Rotation>(this.dir, join(dir, 'rotations', f), this.contentKey),
    );
  }

  // ── attestations / anchors (§1.3, §1.5, §1.6) ───────────────────────────────────────────

  putAttestation(persona: string, attestation: Attestation): void {
    const dir = this.requirePersona(persona);
    // The id being written is a path segment exactly as the one being read is (`getAttestation`),
    // and it arrives from the wire. Checked on both sides or the scoping is one-way.
    assertHexId(attestation.subject, 'attestation.subject');
    writeSealed(this.dir, 
      join(dir, 'attestations', `${attestation.subject}.json`),
      this.contentKey,
      'attestation',
      attestation,
    );
    this.commit(`feat(attestation): ${attestation.subject.slice(0, 12)}`);
  }

  getAttestation(persona: string, subject: string): Attestation | null {
    const dir = this.requirePersona(persona);
    assertHexId(subject, 'subject');
    const path = join(dir, 'attestations', `${subject}.json`);
    if (!existsSync(path)) return null;
    return readSealed<Attestation>(this.dir, path, this.contentKey);
  }

  putRevocation(persona: string, revocation: Revocation): void {
    const dir = this.requirePersona(persona);
    assertHexId(revocation.subject, 'revocation.subject');
    writeSealed(this.dir, 
      join(dir, 'revocations', `${revocation.subject}.json`),
      this.contentKey,
      'revocation',
      revocation,
    );
    this.commit(`feat(revocation): ${revocation.subject.slice(0, 12)}`);
  }

  getRevocation(persona: string, subject: string): Revocation | null {
    const dir = this.requirePersona(persona);
    assertHexId(subject, 'subject');
    const path = join(dir, 'revocations', `${subject}.json`);
    if (!existsSync(path)) return null;
    return readSealed<Revocation>(this.dir, path, this.contentKey);
  }

  /**
   * §1.5 anchors are fetched over the network by a federating node. An L0–L1 node (M-10) has
   * no network, so it can only use an anchor a human or a connector previously cached here.
   */
  putDomainAnchor(persona: string, anchor: DomainAnchor): void {
    const dir = this.requirePersona(persona);
    assertHexId(anchor.org_root, 'org_root');
    writeSealed(this.dir, join(dir, 'anchors', `${anchor.org_root}.json`), this.contentKey, 'anchor', anchor);
    this.commit(`feat(anchor): ${anchor.org_root.slice(0, 12)}`);
  }

  getDomainAnchor(persona: string, orgRoot: string): DomainAnchor | null {
    const dir = this.requirePersona(persona);
    assertHexId(orgRoot, 'org_root');
    const path = join(dir, 'anchors', `${orgRoot}.json`);
    if (!existsSync(path)) return null;
    return readSealed<DomainAnchor>(this.dir, path, this.contentKey);
  }

  // ── pending extraction queue (§7 confirm) ───────────────────────────────────────────────

  putPending(item: PendingExtraction): void {
    const dir = this.requirePersona(item.persona);
    assertHexId(item.id, 'pending_extraction_id');
    writeSealed(this.dir, join(dir, 'pending', `${item.id}.json`), this.contentKey, 'pending', item);
    this.commit(`feat(pending): queue ${item.id.slice(0, 12)}`);
  }

  getPending(persona: string, id: string): PendingExtraction | null {
    const dir = this.requirePersona(persona);
    assertHexId(id, 'pending_extraction_id');
    const path = join(dir, 'pending', `${id}.json`);
    if (!existsSync(path)) return null;
    return readSealed<PendingExtraction>(this.dir, path, this.contentKey);
  }

  listPending(persona: string): PendingExtraction[] {
    const dir = this.requirePersona(persona);
    return listFiles(join(dir, 'pending')).map((f) =>
      readSealed<PendingExtraction>(this.dir, join(dir, 'pending', f), this.contentKey),
    );
  }

  deletePending(persona: string, id: string): boolean {
    const dir = this.requirePersona(persona);
    assertHexId(id, 'pending_extraction_id');
    const removed = removeFile(join(dir, 'pending', `${id}.json`));
    if (removed) this.commit(`chore(pending): dequeue ${id.slice(0, 12)}`);
    return removed;
  }

  // ── outbox (M-10: producing a wire message must not require a network) ──────────────────

  putOutbox(item: OutboxItemInput): void {
    // Parsed on the way in so a producer supplies only what it knows: L1 has queued a message
    // and has not yet met a transport, so `delivery` is the schema's own "never attempted".
    const queued = OutboxItem.parse(item);
    const dir = this.requirePersona(queued.persona);
    assertHexId(queued.id, 'outbox id');
    writeSealed(this.dir, join(dir, 'outbox', `${queued.id}.json`), this.contentKey, 'outbox', queued);
    this.commit(`feat(outbox): queue ${queued.id.slice(0, 12)}`);
  }

  listOutbox(persona: string): OutboxItem[] {
    const dir = this.requirePersona(persona);
    return listFiles(join(dir, 'outbox')).map((f) =>
      // Parsed rather than cast. An item written before delivery state existed carries no
      // `delivery` member, and the schema's defaults are what make it read as "queued, never
      // attempted" in every caller instead of `undefined` at the first property access.
      OutboxItem.parse(readSealed<unknown>(this.dir, join(dir, 'outbox', f), this.contentKey)),
    );
  }

  /**
   * Record what a courier did with a queued message.
   *
   * Only `delivery` is replaceable: the message itself is signed, so rewriting any other member
   * would invalidate it. The write is read-modify-write because a caller learns one fact at a
   * time — that a transport accepted it, and much later that the recipient acknowledged it.
   */
  recordOutboxDelivery(persona: string, id: string, patch: Partial<OutboxDelivery>): OutboxItem | null {
    const dir = this.requirePersona(persona);
    assertHexId(id, 'outbox id');
    const path = join(dir, 'outbox', `${id}.json`);
    if (!existsSync(path)) return null;
    const item = OutboxItem.parse(readSealed<unknown>(this.dir, path, this.contentKey));
    const updated: OutboxItem = { ...item, delivery: { ...item.delivery, ...patch } };
    writeSealed(this.dir, path, this.contentKey, 'outbox', updated);
    this.commit(`chore(outbox): delivery ${id.slice(0, 12)}`);
    return updated;
  }

  // ── retention (§5.4) ────────────────────────────────────────────────────────────────────

  setRetentionPolicy(retentionDays: number): void {
    this.writeRetentionPolicy(retentionDays);
    this.commit(`chore(retention): window ${retentionDays}d`);
  }

  /** Write without committing — used during creation, so the vault has one initial commit. */
  private writeRetentionPolicy(retentionDays: number): void {
    const policy: RetentionPolicy = {
      v: PROTOCOL_VERSION,
      type: 'retention_policy',
      retention_days: retentionDays,
    };
    writeJson(join(this.dir, 'retention.json'), policy);
  }

  retentionPolicy(): RetentionPolicy {
    const path = join(this.dir, 'retention.json');
    if (!existsSync(path)) {
      return { v: PROTOCOL_VERSION, type: 'retention_policy', retention_days: DEFAULT_RETENTION_DAYS };
    }
    return readJson<RetentionPolicy>(path);
  }

  // ── M-5 escape hatch ────────────────────────────────────────────────────────────────────

  /**
   * §5.3 M-5, the sole exception: "Cross-scope *ordering* of opaque items in a personal
   * attention queue is permitted; content transfer is not."
   *
   * This is the ONLY method that reads more than one persona's subtree. It returns ordering
   * keys — age, due, blocking count, state — and no content whatsoever. A caller that wants a
   * headline must go back through the single-persona read APIs with that item's persona, which
   * is what `brief` does. Do not add a text field here.
   */
  listOrderingKeysAcrossPersonas(): OrderingKey[] {
    const keys: OrderingKey[] = [];
    for (const persona of this.listPersonaIds()) {
      keys.push(...this.listOrderingKeys(persona));
    }
    return keys;
  }

  /** Single-persona ordering keys. Safe to combine only via the hatch above. */
  listOrderingKeys(persona: string): OrderingKey[] {
    const keys: OrderingKey[] = [];
    const edgeIds = new Set(this.listEdgeIds(persona));

    for (const { hash, commitment } of this.listCommitments(persona)) {
      keys.push({
        persona,
        kind: 'commitment',
        id: hash,
        since: commitment.created_at,
        due: commitment.due,
        blocking_count: commitment.conditions.length,
        state: 'vault-local',
      });
    }
    for (const edgeId of edgeIds) {
      const edge = this.getEdge(persona, edgeId);
      if (!edge) continue;
      keys.push({
        persona,
        kind: 'edge',
        id: edgeId,
        since: edge.proposed_at,
        due: edge.due,
        blocking_count: edge.blocked_by.length,
        state: 'unresolved',
      });
    }
    for (const { id, expectation } of this.listExpectations(persona)) {
      keys.push({
        persona,
        kind: 'expectation',
        id,
        since: expectation.since,
        due: null,
        blocking_count: 0,
        state: expectation.state,
      });
    }
    return keys;
  }
}

/**
 * The version the vault on disk was written at, checked before a key is derived from it.
 *
 * `assertVaultRepo` asked whether the marker file EXISTS; nothing read what it said. A vault
 * written by a later Servanda therefore opened under this version's rules and was read with them,
 * and the first sign of trouble was whatever that produced downstream — or, when the later version
 * had also changed the keyset, the message "no passphrase wrap could be opened", which is what a
 * WRONG PASSPHRASE says. Somebody whose newer laptop wrote the vault and whose older desktop reads
 * it would have spent the evening retyping a passphrase that was correct every time.
 *
 * Refusing is the conservative direction and the only honest one: this code cannot know what a
 * later version changed, and a vault is the thing you cannot rebuild by reinstalling.
 */
/**
 * The §9.3 profile a keyset's passphrase wrap already uses, as a full parameter set.
 *
 * `kdfProfileOf` reports `m`, `t` and `p` because those are what a wrap records; `dkLen` is not
 * a §9.3 parameter and is fixed by the content key's length, so it comes from the defaults.
 */
function profileOf(keyset: ContentKeySet): Argon2idParams {
  const kdf = kdfProfileOf(keyset);
  return kdf ? { ...kdf, dkLen: ARGON2ID_PARAMS.dkLen } : ARGON2ID_PARAMS;
}

function assertSupportedVersion(dir: string): void {
  const path = join(dir, VAULT_MARKER);
  let descriptor: Partial<VaultDescriptor>;
  try {
    descriptor = readJson<VaultDescriptor>(path);
  } catch (cause) {
    throw new VaultError(
      `${VAULT_MARKER} in ${dir} is damaged: it should be this vault's descriptor and it is not ` +
        `readable JSON. It is a small file with no secret in it — this vault's git history has ` +
        `the last good copy, and nothing else in the vault is affected.`,
      { cause },
    );
  }
  if (descriptor.v !== PROTOCOL_VERSION) {
    throw new VaultError(
      `this vault says it was written for ${String(descriptor.v)}; this build speaks ` +
        `${PROTOCOL_VERSION}. Nothing here is lost and the passphrase is not the problem — open it ` +
        `with the Servanda that wrote it, or upgrade this one.`,
    );
  }
}

/** Read `keyset.json`, distinguishing "no keyset" and "damaged keyset" from "wrong passphrase". */
function readKeyset(dir: string): ContentKeySet {
  const path = join(dir, 'keyset.json');
  if (!existsSync(path)) {
    throw new VaultError(
      `${path} is missing. It holds the wrapped content key, so without it neither the passphrase ` +
        `nor any device key opens this vault. It is in the vault's git history: recover it there ` +
        `before anything else writes to the vault.`,
    );
  }
  try {
    return readJson<ContentKeySet>(path);
  } catch (cause) {
    throw new VaultError(
      `${path} is not readable JSON, so it was damaged or written only partly. This is the one ` +
        `file the whole vault depends on, and it is in the vault's git history — recover it from ` +
        `there. The records themselves are untouched.`,
      { cause },
    );
  }
}

/**
 * The passphrase failure a person actually has, rather than the one the AEAD can prove.
 *
 * `unwrapWithPassphrase` reports exactly one thing — no wrap opened — and it says the same words
 * whether the passphrase was mistyped or `keyset.json` lost a byte. Those have opposite first
 * moves: one is "try again", the other is "stop typing, the file is damaged, get it out of git".
 * The message below refuses to choose between them, which is honest, and names both moves.
 *
 * There is no attempt counter and no lockout, deliberately. Nothing here is a network service that
 * an attacker could ask a thousand times; whoever can attempt an open is holding the directory and
 * can copy it and attack the copy at whatever rate their hardware allows. A counter would not slow
 * them by one derivation and would lock out the one person it can reach — its owner, at 2am, on
 * the try before the right one. The Argon2id cost IS the rate limit.
 *
 * Anything else thrown from the unwrap is a REFUSAL rather than a failure to match: the wrap
 * declared a cost this build will not spend, or the machine could not allocate it. That is not
 * about the passphrase at all, and saying so keeps somebody from retyping against a phone-sized
 * machine that cannot open a desktop-sized wrap.
 */
function unwrapPassphraseOrExplain(dir: string, keyset: ContentKeySet, passphrase: string): Uint8Array {
  try {
    return unwrapWithPassphrase(keyset, passphrase);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!message.startsWith('no passphrase wrap could be opened')) {
      const kdf = kdfProfileOf(keyset);
      throw new VaultError(
        `the passphrase was never tried against ${join(dir, 'keyset.json')}: ${message}. ` +
          `This vault's passphrase wrap asks for ${kdf ? `m=${kdf.m} KiB, t=${kdf.t}, p=${kdf.p}` : 'a cost'} ` +
          `and this machine or this build would not spend it — it is not a wrong passphrase. Open ` +
          `the vault on the machine that made it, or on one with more memory free.`,
        { cause },
      );
    }
    const slots = keyset.wraps.filter((w) => w.kind === 'passphrase').length;
    throw new VaultError(
      `none of the ${slots} passphrase wrap${slots === 1 ? '' : 's'} in ${join(dir, 'keyset.json')} ` +
        `opened. Either the passphrase is wrong — there is no lockout, so try again as often as you ` +
        `need — or keyset.json has been altered since it was written, in which case no passphrase ` +
        `will ever open it and the last good copy is in this vault's git history.`,
      { cause },
    );
  }
}

/**
 * Storage key for a commitment: the §3.2 commitment_hash, recomputed from the record rather
 * than taken from a field, so nothing can be filed under a hash that does not describe it.
 */
export function commitmentKey(c: Commitment): string {
  return commitmentHash({
    intent: c.intent,
    owner: c.owner,
    owed_to: c.owed_to,
    due: c.due,
    created_at: c.created_at,
  });
}
