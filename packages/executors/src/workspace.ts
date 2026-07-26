import { assertPermitted, normalizeWorkspacePath, permits } from './capabilities.js';
import type { CapabilitySet } from './capabilities.js';

/**
 * The only world an executor sees.
 *
 * A `Workspace` is built from a snapshot the *host* prepared — the executor process never opens
 * a file, because it is never given a filesystem. Everything it can read was already selected by
 * its `read` capability before its process started; everything it writes is a proposal returned
 * to the host, which validates it again. Nothing here touches disk.
 *
 * This is what makes "produces an artifact for review, never acts" structural rather than a
 * promise: the executor has no verb that reaches the world.
 */

export type Snapshot = Readonly<Record<string, string>>;

export interface Proposal {
  /** Full new contents, keyed by workspace-relative path. */
  readonly writes: Readonly<Record<string, string>>;
  readonly deletes: readonly string[];
}

export class Workspace {
  readonly #files: Map<string, string>;
  readonly #capabilities: CapabilitySet;
  readonly #writes = new Map<string, string>();
  readonly #deletes = new Set<string>();

  constructor(snapshot: Snapshot, capabilities: CapabilitySet) {
    this.#capabilities = capabilities;
    this.#files = new Map();
    for (const [path, contents] of Object.entries(snapshot)) {
      // The host should never have handed us an unreadable path; if it did, that is a host bug
      // and the executor must not paper over it.
      this.#files.set(assertPermitted(capabilities, 'read', path), contents);
    }
  }

  /** Paths visible to this executor, in sorted order. */
  list(glob?: string): string[] {
    const all = [...this.#files.keys()].sort();
    if (glob === undefined) return all;
    return all.filter((path) => permits({ ...this.#capabilities, read: [glob] }, 'read', path));
  }

  exists(path: string): boolean {
    return this.#files.has(normalizeWorkspacePath(path));
  }

  read(path: string): string {
    const normalized = assertPermitted(this.#capabilities, 'read', path);
    const contents = this.#files.get(normalized);
    if (contents === undefined) {
      throw new Error(`no such file in this workspace: ${normalized}`);
    }
    return contents;
  }

  readOrNull(path: string): string | null {
    const normalized = assertPermitted(this.#capabilities, 'read', path);
    return this.#files.get(normalized) ?? null;
  }

  write(path: string, contents: string): void {
    const normalized = assertPermitted(this.#capabilities, 'write', path);
    this.#deletes.delete(normalized);
    this.#writes.set(normalized, contents);
    this.#files.set(normalized, contents);
  }

  delete(path: string): void {
    const normalized = assertPermitted(this.#capabilities, 'write', path);
    this.#writes.delete(normalized);
    this.#deletes.add(normalized);
    this.#files.delete(normalized);
  }

  proposal(): Proposal {
    return {
      writes: Object.fromEntries([...this.#writes.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      deletes: [...this.#deletes].sort(),
    };
  }
}
