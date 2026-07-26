import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { unwrapWithPassphrase } from '@servanda/crypto';
import { listFiles, readSealed, writeSealed } from '@servanda/vault';
import type { Vault } from '@servanda/vault';
import { applyOutcome, emptyTrustRecord, TrustRecord } from './gradient.js';
import type { ReviewOutcome } from './gradient.js';

/**
 * Trust history, persisted in the vault (L0).
 *
 * It lives under the persona directory, sealed with the vault's own content key and in the
 * vault's own record format, for three reasons: it is per-persona by construction (M-5 needs no
 * separate enforcement — there is no path to another persona's history); it inherits vault
 * retention and the git-backed tamper-evident history; and a stolen disk yields nothing, because
 * "how much autonomy this human has granted which class" is exactly the metadata an attacker
 * would use to pick a target.
 */

const WORK_CLASS = /^[a-z][a-z0-9-]{0,31}$/;

export class TrustStoreError extends Error {
  override name = 'TrustStoreError';
}

function trustDir(vaultDir: string, persona: string): string {
  if (!/^[0-9a-f]{64}$/.test(persona)) {
    throw new TrustStoreError(`persona_id must be 64 lowercase hex characters, got: ${persona}`);
  }
  return join(vaultDir, 'personas', persona, 'trust');
}

function recordPath(vaultDir: string, persona: string, workClass: string): string {
  if (!WORK_CLASS.test(workClass)) {
    throw new TrustStoreError(`work class must match ${WORK_CLASS}, got: ${workClass}`);
  }
  return join(trustDir(vaultDir, persona), `${workClass}.json`);
}

export interface TrustStoreOptions {
  readonly dir: string;
  readonly contentKey: Uint8Array;
  readonly now?: () => string;
}

export class TrustStore {
  readonly #dir: string;
  readonly #contentKey: Uint8Array;
  readonly #now: () => string;

  private constructor(options: TrustStoreOptions) {
    this.#dir = options.dir;
    this.#contentKey = options.contentKey;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Open against a live vault. The passphrase is required because the content key is wrapped;
   * a device key alone is never sole custodian (M-16), and this store deliberately does not
   * invent a second custody arrangement of its own.
   */
  static open(vault: Vault, passphrase: string, now?: () => string): TrustStore {
    const contentKey = unwrapWithPassphrase(vault.keyset(), passphrase);
    return new TrustStore({ dir: vault.dir, contentKey, ...(now ? { now } : {}) });
  }

  /** For callers that already hold the unwrapped content key. */
  static openWithKey(options: TrustStoreOptions): TrustStore {
    return new TrustStore(options);
  }

  #requirePersona(persona: string): void {
    // Shape before existence: a malformed persona_id is a caller error, and reporting it as
    // "no such persona" would send someone looking in the vault for a bug in their own string.
    trustDir(this.#dir, persona);
    if (!existsSync(join(this.#dir, 'personas', persona, 'persona.json'))) {
      throw new TrustStoreError(`no such persona in this vault: ${persona}`);
    }
  }

  get(persona: string, workClass: string): TrustRecord {
    this.#requirePersona(persona);
    const path = recordPath(this.#dir, persona, workClass);
    if (!existsSync(path)) return emptyTrustRecord(persona, workClass, this.#now());
    const record = TrustRecord.parse(readSealed<unknown>(path, this.#contentKey));
    if (record.persona !== persona || record.work_class !== workClass) {
      // A record that does not describe the pair it is filed under is not a record we can use.
      throw new TrustStoreError(
        `trust record at ${path} describes (${record.persona}, ${record.work_class})`,
      );
    }
    return record;
  }

  put(record: TrustRecord): void {
    this.#requirePersona(record.persona);
    const parsed = TrustRecord.parse(record);
    writeSealed(
      recordPath(this.#dir, parsed.persona, parsed.work_class),
      this.#contentKey,
      'trust_record',
      parsed,
    );
  }

  /** Apply one review outcome and persist. Returns the new history. */
  record(persona: string, workClass: string, outcome: ReviewOutcome): TrustRecord {
    const next = applyOutcome(this.get(persona, workClass), outcome, this.#now());
    this.put(next);
    return next;
  }

  list(persona: string): TrustRecord[] {
    this.#requirePersona(persona);
    const dir = trustDir(this.#dir, persona);
    return listFiles(dir)
      .map((file) => TrustRecord.parse(readSealed<unknown>(join(dir, file), this.#contentKey)))
      .sort((a, b) => (a.work_class < b.work_class ? -1 : 1));
  }
}
