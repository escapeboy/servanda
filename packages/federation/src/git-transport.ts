import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { WireMessage } from '@servanda/types';
import type { Transport } from './transport.js';
import { edgeIdOf, messageId, verifyMessage } from './messages.js';

/**
 * §6.1 git transport — "a shared repository; messages are files under
 * `servanda/{edge_id}/{seq}-{type}.json`; sync = fetch/push".
 *
 * SPEC AMBIGUITY (narrowest reading; reported, not resolved in code). The path template is
 * keyed on `edge_id`, but §6.2 also defines `recon_request`/`recon_response`/`recover_request`/
 * `recover_response`, which concern no single edge. Rather than invent an edge_id for them, add
 * a recipient field to their payloads (that would be a protocol change), or drop them from this
 * transport, they are filed under the reserved prefix `servanda/_direct/{recipient}/` using the
 * recipient already passed to `send`. `_direct` cannot collide with a real edge directory: edge
 * ids are 64 hex characters and `_` is not a hex digit.
 *
 * CONFIDENTIALITY. This transport IS a shared repository, so its confidentiality boundary is
 * repository access, not the message. §6.3's blind-courier requirement is scoped to "hub-bound
 * payloads" and is implemented in `hub-transport.ts`. What a node *serves on request* — recon
 * and recovery responses — is still governed by M-4a; see `serve.ts`.
 */

export interface GitTransportOptions {
  /** The working clone this side reads and writes. */
  dir: string;
  /** The persona this side speaks as. */
  persona: string;
  /**
   * Path or URL of the shared repository. A local path is a first-class case: two clones of a
   * local bare repo exchange messages with no network at all, which is how the gate proves it.
   */
  remote?: string;
  author?: { name: string; email: string };
}

const SUBDIR = 'servanda';
const DIRECT = '_direct';
const DEFAULT_AUTHOR = { name: 'servanda', email: 'node@servanda.local' };

export class GitTransportError extends Error {
  override name = 'GitTransportError';
}

function git(dir: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new GitTransportError(`git ${args.join(' ')} failed in ${dir}: ${e.stderr ?? e.message}`);
  }
}

/** A message as it sits in the shared repository, with the path that addresses it. */
export interface PlacedMessage {
  /** Path relative to `servanda/` — either `{edge_id}/…` or `_direct/{recipient}/…`. */
  path: string;
  message: WireMessage;
}

export class GitTransport implements Transport {
  readonly kind = 'git' as const;
  readonly dir: string;
  readonly persona: string;
  private readonly remote: string | undefined;
  /** Accepted by `send`, not yet written into the tree. */
  private pending: { recipient: string; message: WireMessage }[] = [];
  /** Content addresses already placed by this side, so a replayed `send` is a no-op. */
  private readonly placed = new Set<string>();

  constructor(opts: GitTransportOptions) {
    this.dir = opts.dir;
    this.persona = opts.persona;
    this.remote = opts.remote;
  }

  /** Initialise a working clone. With a remote, wire it up; otherwise start a standalone repo. */
  static init(opts: GitTransportOptions): GitTransport {
    const { dir } = opts;
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, '.git'))) {
      git(dir, ['init', '--quiet', '--initial-branch=main']);
      if (opts.remote) git(dir, ['remote', 'add', 'origin', opts.remote]);
    }
    const author = opts.author ?? DEFAULT_AUTHOR;
    git(dir, ['config', 'user.name', author.name]);
    git(dir, ['config', 'user.email', author.email]);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    mkdirSync(join(dir, SUBDIR), { recursive: true });
    return new GitTransport(opts);
  }

  /** Create the shared bare repository two clones exchange through. */
  static initShared(dir: string): string {
    mkdirSync(dir, { recursive: true });
    git(dir, ['init', '--bare', '--quiet', '--initial-branch=main']);
    return dir;
  }

  async send(recipient: string, message: WireMessage): Promise<void> {
    if (this.placed.has(messageId(message))) return;
    this.pending.push({ recipient, message });
  }

  async receive(persona: string): Promise<WireMessage[]> {
    const out: WireMessage[] = [];
    for (const { path, message } of this.readAll()) {
      // A courier does not hand a persona back its own outbound copy.
      if (message.sender === persona) continue;
      // `_direct/{recipient}` is addressed; an edge directory is shared-repository visible.
      const parts = path.split(sep);
      if (parts[0] === DIRECT && parts[1] !== persona) continue;
      out.push(message);
    }
    return out;
  }

  /**
   * fetch → adopt the shared history → place anything this side has not yet published →
   * commit → push.
   *
   * Adopting the remote wholesale *before* writing is what makes concurrent senders safe with
   * no merge strategy: every message this side authored is either already in the shared history
   * or still in `pending`, so nothing can be lost, and two senders never name the same file
   * because sequence numbers are assigned after the merge rather than before it.
   */
  async sync(): Promise<void> {
    if (this.remote) {
      git(this.dir, ['fetch', '--quiet', 'origin']);
      if (this.remoteHasMain()) git(this.dir, ['checkout', '--quiet', '-B', 'main', 'origin/main']);
    }

    const written = this.placeAll();

    git(this.dir, ['add', '-A']);
    if (git(this.dir, ['status', '--porcelain']).trim() !== '') {
      git(this.dir, ['commit', '--quiet', '-m', `feat(wire): deliver ${written} message(s)`]);
    }

    if (this.remote) git(this.dir, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
  }

  private remoteHasMain(): boolean {
    try {
      git(this.dir, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']);
      return true;
    } catch {
      return false;
    }
  }

  private placeAll(): number {
    let n = 0;
    for (const { recipient, message } of this.pending) {
      const id = messageId(message);
      if (this.placed.has(id)) continue;
      const dir = join(this.dir, SUBDIR, this.relativeDirFor(recipient, message));
      mkdirSync(dir, { recursive: true });
      if (this.alreadyPresent(dir, id)) {
        this.placed.add(id);
        continue;
      }
      const seq = String(readdirSync(dir).filter((f) => f.endsWith('.json')).length + 1).padStart(4, '0');
      writeFileSync(join(dir, `${seq}-${message.type}.json`), `${JSON.stringify(message, null, 2)}\n`);
      this.placed.add(id);
      n++;
    }
    this.pending = [];
    return n;
  }

  private relativeDirFor(recipient: string, message: WireMessage): string {
    const edge = edgeIdOf(message);
    if (edge !== null) return edge;
    if (!/^[0-9a-f]{64}$/.test(recipient)) {
      throw new GitTransportError(`a ${message.type} needs a persona recipient to be addressable`);
    }
    return join(DIRECT, recipient);
  }

  private alreadyPresent(dir: string, id: string): boolean {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const parsed = this.readFile(join(dir, file));
      if (parsed && messageId(parsed) === id) return true;
    }
    return false;
  }

  private readFile(path: string): WireMessage | null {
    try {
      return verifyMessage(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      return null;
    }
  }

  /** Every signature-valid message currently in the working tree. */
  readAll(): PlacedMessage[] {
    const root = join(this.dir, SUBDIR);
    if (!existsSync(root)) return [];
    const out: PlacedMessage[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith('.json')) {
          const message = this.readFile(p);
          // A file whose signature does not verify never surfaces — a shared repository is
          // writable by everyone who can clone it, so the file is not the authority.
          if (message) out.push({ path: relative(root, p), message });
        }
      }
    };
    walk(root);
    return out;
  }
}
