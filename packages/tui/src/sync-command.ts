import type { Vault } from '@servanda/vault';

/**
 * The half of the product that had no door.
 *
 * `push` and `pull` exist in `@servanda/federation`, are tested, and are called by nothing that
 * ships: a grep for that package across every `src` and `bin` returns the e2e tests and one gate
 * script. So a promise could be recorded, ranked, rendered and closed, and never leave the
 * machine — not because anything was broken, but because no command drove the wire.
 *
 * Found by walking the path rather than by reading it. Two personas, a proposal from one to the
 * other, and `confirm` answered `no such edge` — correctly, because an edge lives under the
 * proposer until the wire carries it, and there was no wire.
 *
 * Deliberately NOT a daemon. §6.7 lets a courier lose, duplicate and reorder, and the answer to
 * all three is to ask again — which is a thing a person does when they want to, not a process
 * that reads their register on a timer.
 */

export interface SyncTransportConfig {
  readonly kind: 'git';
  /** Path or URL of the shared repository. A local path is first-class: two clones, no network. */
  readonly remote: string;
  /** The working clone this side reads and writes. Kept out of the vault, like all node-local state. */
  readonly dir: string;
}

export class SyncError extends Error {}

/**
 * Where the courier is configured, read from the environment for now.
 *
 * One transport, named explicitly. §6.1's per-recipient routing is what lets one node hold
 * several couriers, and this does not expose it — a person on a shared repository and a person
 * on a hub still cannot reach each other. That limit is stated rather than hidden, because the
 * failure without it is silent: messages queue as `unroutable` and nothing says why.
 */
export function transportFromEnv(env: Record<string, string | undefined>): SyncTransportConfig | null {
  const remote = env['SERVANDA_GIT_REMOTE'];
  if (remote === undefined || remote === '') return null;
  const dir = env['SERVANDA_GIT_CLONE'];
  if (dir === undefined || dir === '') {
    throw new SyncError(
      'SERVANDA_GIT_REMOTE is set but SERVANDA_GIT_CLONE is not.\n' +
        'The clone is a working directory the courier reads and writes. It must NOT be inside\n' +
        'your vault: the vault commits everything in its tree, and a courier writing there would\n' +
        'put wire traffic into the record it is meant to carry.',
    );
  }
  return { kind: 'git', remote, dir };
}

export const SYNC_HELP = `servanda sync — send what you have written, collect what has arrived

  export SERVANDA_GIT_REMOTE=/path/to/shared.git   # or a URL
  export SERVANDA_GIT_CLONE=~/.servanda-courier    # NOT inside your vault
  servanda sync

Both people point at the same repository. Nothing in it is readable by anyone but the
recipient — §6.3: a courier carries sealed envelopes and cannot open them.`;

export interface SyncReport {
  readonly sent: number;
  readonly accepted: number;
  readonly discarded: number;
  readonly suppressed: number;
  readonly failures: readonly { recipient: string; reason: string }[];
}

/** What a person is told. Every number that is not zero gets a sentence. */
export function describeSync(r: SyncReport): string {
  const lines: string[] = [];
  lines.push(
    r.sent === 0
      ? 'Nothing was waiting to go out.'
      : r.sent === 1
        ? '1 message sent.'
        : `${r.sent} messages sent.`,
  );
  lines.push(
    r.accepted === 0
      ? 'Nothing new arrived.'
      : r.accepted === 1
        ? '1 message arrived and was recorded.'
        : `${r.accepted} messages arrived and were recorded.`,
  );
  // Discarded is not an error and not a success: §6.2 says a message whose signature does not
  // verify is dropped, and M-14 says an invalid assertion is discarded. Somebody watching a
  // number that never moves should be able to see it move.
  if (r.discarded > 0) {
    lines.push(`${r.discarded} were discarded — they did not verify, so nothing was recorded from them.`);
  }
  if (r.suppressed > 0) {
    lines.push(`${r.suppressed} were held back by the §6.5 budget rather than processed.`);
  }
  for (const f of r.failures) {
    // Named, because "sync failed" for one unreachable counterparty while everything else went
    // is the report that made `push` all-or-nothing in the first place.
    lines.push(`Could not deliver to ${f.recipient}: ${f.reason}`);
  }
  return lines.join('\n');
}

/**
 * Drive one exchange.
 *
 * `@servanda/federation` is imported by the CALLER and handed in, so this module — and the
 * terminal package around it — carries no transport of its own. Gate GL proves the gesture
 * surface opens no connection; the same reasoning keeps a network client out of here.
 */
export async function runSync(
  makeNode: (vault: Vault, persona: string, config: SyncTransportConfig) => {
    push(): Promise<number>;
    pull(): Promise<{ accepted: unknown[]; discarded: unknown[]; suppressed: unknown[] }>;
  },
  vault: Vault,
  persona: string,
  config: SyncTransportConfig,
): Promise<SyncReport> {
  const node = makeNode(vault, persona, config);

  let sent = 0;
  const failures: { recipient: string; reason: string }[] = [];
  try {
    sent = await node.push();
  } catch (error) {
    // `push` throws AFTER attempting everyone — that is what stops one bad recipient starving
    // the rest — and the aggregate carries who failed and why. Reported per recipient rather
    // than as one word, because "one person is unreachable" and "the courier is down" are
    // different things to do something about.
    const agg = error as { delivered?: number; failures?: { recipient: string; reason: string }[] };
    sent = agg.delivered ?? 0;
    for (const f of agg.failures ?? []) failures.push({ recipient: f.recipient, reason: f.reason });
    if (agg.failures === undefined) throw error;
  }

  const inbound = await node.pull();
  return {
    sent,
    accepted: inbound.accepted.length,
    discarded: inbound.discarded.length,
    suppressed: inbound.suppressed.length,
    failures,
  };
}
