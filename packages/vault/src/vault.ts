import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
  type OutboxItem,
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

export class Vault {
  readonly dir: string;
  private readonly contentKey: Uint8Array;
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
    const keyset = readJson<ContentKeySet>(join(dir, 'keyset.json'));
    // M-16 on every open, not only on create. `sealContentKey` proves no code here BUILDS a
    // device-only keyset; it proves nothing about the unsigned JSON file sitting in a directory
    // its owner can write. Deleting the passphrase wrap produced a keyset that satisfied every
    // schema, violated M-16, and opened. Custody is a property a vault has at rest.
    assertM16(keyset.wraps);
    let contentKey: Uint8Array;
    if (opts.passphrase !== undefined) {
      contentKey = unwrapWithPassphrase(keyset, opts.passphrase);
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

  putPersona(record: PersonaRecord): void {
    const dir = this.personaDir(record.persona_id);
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

  putOutbox(item: OutboxItem): void {
    const dir = this.requirePersona(item.persona);
    assertHexId(item.id, 'outbox id');
    writeSealed(this.dir, join(dir, 'outbox', `${item.id}.json`), this.contentKey, 'outbox', item);
    this.commit(`feat(outbox): queue ${item.id.slice(0, 12)}`);
  }

  listOutbox(persona: string): OutboxItem[] {
    const dir = this.requirePersona(persona);
    return listFiles(join(dir, 'outbox')).map((f) =>
      readSealed<OutboxItem>(this.dir, join(dir, 'outbox', f), this.contentKey),
    );
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
