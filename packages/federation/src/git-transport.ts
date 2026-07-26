import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WireMessage } from '@servanda/types';
import type { Transport } from './transport.js';
import { edgeIdOf, messageId, verifyMessage } from './messages.js';

/**
 * §6.1 git transport — "a shared repository; messages are files under
 * `servanda/{edge_id}/{seq}-{type}.json`; sync = fetch/push".
 *
 * SPEC AMBIGUITY (narrowest reading, reported upstream). The path template is keyed on
 * `edge_id`, but §6.2 also defines `recon_request`/`recon_response`/`recover_request`/
 * `recover_response`, which concern no single edge. Rather than invent an edge_id for them or
 * drop them from this transport, they go under the reserved prefix `servanda/_direct/
 * {recipient}/`. `_direct` cannot collide with a real directory name: edge ids are 64 hex
 * characters and `_` is not a hex digit.
 *
 * CONFIDENTIALITY. This transport is a shared repository, so its confidentiality boundary is
 * repository access — not the message. §6.3's blind-courier requirement is scoped to
 * "hub-bound payloads" and is implemented in `hub-transport.ts`. What is *served* on request
 * (recon and recovery responses) is still governed by M-4a; see `serve.ts`.
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

interface Placed {
  path: string;
  message: WireMessage;
}

export class GitTransport implements Transport {
  readonly kind = 'git' as const;
  readonly dir: string;
  private readonly persona: string;
  private readonly remote: string | undefined;
  private readonly author: { name: string; email: string };
  /** Messages accepted by `send` but not yet written into the tree. */
  private pending: WireMessage[] = [];
  /** Content addresses already placed by this side, so a replayed `send` is a no-op. */
  private readonly placed = new Set<string>();

  constructor(opts: GitTransportOptions) {
    this.dir = opts.dir;
    this.persona = opts.persona;
    this.remote = opts.remote;
    this.author = opts.author ?? DEFAULT_AUTHOR;
  }

  /** Initialise a working clone. With a remote, clone it; otherwise start an empty repo. */
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

  async send(_recipient: string, message: WireMessage): Promise<void> {
    if (this.placed.has(messageId(message))) return;
    this.pending.push(message);
  }

  async receive(persona: string): Promise<WireMessage[]> {
    const out: WireMessage[] = [];
    for (const { message } of this.readAll()) {
      // A courier delivers what it holds; it does not deliver a persona its own outbound copy.
      if (message.sender === persona) continue;
      out.push(message);
    }
    return out;
  }

  /**
   * fetch → adopt the shared history → re-place anything this side has not yet published →
   * commit → push.
   *
   * Adopting the remote wholesale before writing is what makes concurrent senders safe without
   * a merge strategy: a message is either already in the shared history or still in `pending`,
   * so nothing this side authored can be lost, and two senders never name the same file because
   * sequence numbers are assigned after the merge, not before it.
   */
  async sync(): Promise<void> {
    if (this.remote) {
      git(this.dir, ['fetch', '--quiet', 'origin']);
      if (this.remoteHasMain()) {
        git(this.dir, ['checkout', '--quiet', '-B', 'main', 'origin/main']);
      }
    }

    const written = this.placeAll(this.pending);
    this.pending = [];

    git(this.dir, ['add', '-A']);
    if (git(this.dir, ['status', '--porcelain']).trim() !== '') {
      git(this.dir, ['commit', '--quiet', '-m', `feat(wire): deliver ${written} message(s)`]);
    }

    if (this.remote) {
      git(this.dir, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main']);
    }
  }

  private remoteHasMain(): boolean {
    try {
      git(this.dir, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']);
      return true;
    } catch {
      return false;
    }
  }

  private placeAll(messages: WireMessage[]): number {
    let n = 0;
    for (const message of messages) {
      const id = messageId(message);
      if (this.placed.has(id)) continue;
      const dir = join(this.dir, SUBDIR, this.relativeDirFor(message));
      mkdirSync(dir, { recursive: true });
      // Idempotence across clones: a message already present under any name is not rewritten.
      if (this.alreadyPresent(dir, id)) {
        this.placed.add(id);
        continue;
      }
      const seq = String(readdirSync(dir).filter((f) => f.endsWith('.json')).length + 1).padStart(4, '0');
      writeFileSync(join(dir, `${seq}-${message.type}.json`), `${JSON.stringify(message, null, 2)}\n`);
      this.placed.add(id);
      n++;
    }
    return n;
  }

  private relativeDirFor(message: WireMessage): string {
    const edge = edgeIdOf(message);
    if (edge !== null) return edge;
    const recipient = this.recipientOf(message);
    return join(DIRECT, recipient);
  }

  /**
   * Non-edge-scoped messages carry their recipient in the payload; `recon_*` and `recover_*`
   * are always addressed, never broadcast.
   */
  private recipientOf(message: WireMessage): string {
    const p = message.payload as Record<string, unknown> | null | undefined;
    const to = p && typeof p === 'object' ? p['to'] : undefined;
    if (typeof to === 'string' && /^[0-9a-f]{64}$/.test(to)) return to;
    throw new GitTransportError(
      `a non-edge-scoped ${message.type} must name its recipient as payload.to (§6.1 path layout is edge-keyed)`,
    );
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
  readAll(): Placed[] {
    const root = join(this.dir, SUBDIR);
    if (!existsSync(root)) return [];
    const out: Placed[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith('.json')) {
          const message = this.readFile(p);
          // A file whose signature does not verify is discarded here and never surfaces.
          if (message) out.push({ path: p, message });
        }
      }
    };
    walk(root);
    return out;
  }

  /** The persona this transport speaks as. */
  get self(): string {
    return this.persona;
  }
}
