import { describe, expect, it } from 'vitest';
import type { Vault } from '@servanda/vault';
import { SYNC_HELP, SyncError, describeSync, runSync, transportFromEnv } from '../src/sync-command.js';

/**
 * The half of the product that had no door.
 *
 * `push` and `pull` are implemented and tested in `@servanda/federation`, and a grep for that
 * package across every shipped `src` and `bin` returned the e2e tests and one gate script. So a
 * promise could be recorded, ranked, rendered and closed and never leave the machine — not
 * because anything was broken, but because nothing drove the wire.
 *
 * Found by walking it: two vaults, a proposal from one to the other, and `confirm` answered
 * `no such edge`. Correct — an edge lives under the proposer until a courier carries it — and
 * there was no courier to run.
 */
describe('where the courier is configured', () => {
  it('is nowhere, by default, and that is not an error', () => {
    // A person with no counterparty is the base case (§0), not a misconfiguration.
    expect(transportFromEnv({})).toBeNull();
    expect(transportFromEnv({ SERVANDA_GIT_REMOTE: '' })).toBeNull();
  });

  it('refuses a remote with no clone rather than choosing a directory itself', () => {
    // The clone MUST NOT be inside the vault: the vault commits its whole tree, so a courier
    // writing there would put wire traffic into the record it exists to carry. Picking a default
    // would be this code deciding where somebody's wire traffic lives.
    expect(() => transportFromEnv({ SERVANDA_GIT_REMOTE: '/tmp/shared.git' })).toThrow(SyncError);
    expect(() => transportFromEnv({ SERVANDA_GIT_REMOTE: '/tmp/shared.git' })).toThrow(/must NOT be inside/u);
  });

  it('takes both together', () => {
    const c = transportFromEnv({ SERVANDA_GIT_REMOTE: '/tmp/s.git', SERVANDA_GIT_CLONE: '/tmp/c' })!;
    expect(c).toEqual({ kind: 'git', remote: '/tmp/s.git', dir: '/tmp/c' });
  });

  it('and the help names both variables, because one without the other is the common mistake', () => {
    expect(SYNC_HELP).toContain('SERVANDA_GIT_REMOTE');
    expect(SYNC_HELP).toContain('SERVANDA_GIT_CLONE');
  });
});

const vault = {} as Vault;
const CONFIG = { kind: 'git', remote: '/tmp/s.git', dir: '/tmp/c' } as const;

function node(over: Partial<{ push: () => Promise<number>; pull: () => Promise<unknown> }> = {}) {
  return () =>
    ({
      push: over.push ?? (async () => 0),
      pull:
        over.pull ??
        (async () => ({ accepted: [], discarded: [], suppressed: [] })),
    }) as never;
}

describe('what one exchange reports', () => {
  it('says both halves even when both are empty', async () => {
    // "Nothing went and nothing came" must be distinguishable from "it did not run". A command
    // that prints nothing on the quiet path teaches people to stop running it.
    const r = await runSync(node(), vault, 'a'.repeat(64), CONFIG);
    const text = describeSync(r);
    expect(text).toContain('Nothing was waiting to go out.');
    expect(text).toContain('Nothing new arrived.');
  });

  it('counts what went and what came', async () => {
    const r = await runSync(
      node({
        push: async () => 2,
        pull: async () => ({ accepted: [1, 2, 3], discarded: [], suppressed: [] }),
      }),
      vault,
      'a'.repeat(64),
      CONFIG,
    );
    expect(describeSync(r)).toContain('2 messages sent.');
    expect(describeSync(r)).toContain('3 messages arrived');
  });

  it('says when something was discarded, because a silent drop is indistinguishable from silence', async () => {
    // §6.2 discards a message whose signature does not verify and M-14 discards an invalid
    // assertion. Both are correct behaviour and both must be visible: a number that never moves
    // is the only way somebody notices they are being sent rubbish.
    const r = await runSync(
      node({ pull: async () => ({ accepted: [], discarded: [1, 2], suppressed: [3] }) }),
      vault,
      'a'.repeat(64),
      CONFIG,
    );
    const text = describeSync(r);
    expect(text).toMatch(/2 were discarded/u);
    expect(text).toMatch(/1 were held back by the §6.5 budget/u);
  });

  it('names each undeliverable recipient, and still reports what DID go', async () => {
    // `push` throws after attempting everyone — that is what stops one bad recipient starving
    // the rest — and the aggregate says who failed. Collapsing this to "sync failed" would put
    // back exactly the all-or-nothing report the outbox fix removed.
    const err = Object.assign(new Error('delivery'), {
      delivered: 1,
      failures: [{ recipient: 'boyan', reason: 'hub refused: HTTP 503' }],
    });
    const r = await runSync(
      node({
        push: async () => {
          throw err;
        },
        pull: async () => ({ accepted: [1], discarded: [], suppressed: [] }),
      }),
      vault,
      'a'.repeat(64),
      CONFIG,
    );
    expect(r.sent).toBe(1);
    expect(describeSync(r)).toContain('Could not deliver to boyan: hub refused: HTTP 503');
    // …and the inbound half still ran. A failure going out is not a reason to skip what came in.
    expect(r.accepted).toBe(1);
  });

  it('rethrows an error that is not a delivery aggregate rather than reporting a clean run', async () => {
    // A courier that is not there at all, a clone that will not open: those are not "one
    // recipient unreachable", and swallowing them into a report of zero would say the exchange
    // happened.
    await expect(
      runSync(
        node({
          push: async () => {
            throw new Error('no such repository');
          },
        }),
        vault,
        'a'.repeat(64),
        CONFIG,
      ),
    ).rejects.toThrow(/no such repository/u);
  });
});
