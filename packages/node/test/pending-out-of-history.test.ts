import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Commitment } from '@servanda/types';
import { makeFixture, type Fixture } from './support/fixture.js';

/**
 * An unconfirmed candidate is a GUESS about what somebody meant, and a guess does not earn a
 * permanent home.
 *
 * The queue used to be a vault store. The vault is a git repository — which is why §4.2's
 * append-only chains are sound — so `deletePending` wrote a commit that removed the file from the
 * working tree while the sealed blob stayed in history under the same content key. `git show
 * HEAD~1:<path>` plus the passphrase handed it straight back.
 *
 * That was harmless while nothing filled the queue. With §3 ingestion wired it stops being
 * harmless: every utterance a model reads as a promise lands verbatim, for ever, without anyone
 * having agreed to it. This file is the test that the fix is real rather than intended.
 */
describe('the confirmation queue does not enter the vault, or its history', () => {
  let fx: Fixture;
  let pendingId: string;
  const SECRET = 'a sentence nobody confirmed and nobody should be stuck with';

  beforeAll(() => {
    fx = makeFixture();
    const persona = fx.personas[0]!;
    const candidate = {
      v: 'servanda/0.2',
      type: 'commitment',
      owner: persona,
      owed_to: fx.personas[1]!,
      intent: SECRET,
      due: null,
      created_at: fx.now.toISOString(),
      source: 'extracted',
    } as unknown as Commitment;
    pendingId = fx.node.queuePendingExtraction(persona, candidate, null);
  });

  afterAll(() => fx.cleanup());

  it('queues it, and the node can read it back', () => {
    const item = fx.node.local.getPending(fx.personas[0]!, pendingId);
    expect(item).not.toBeNull();
    expect((item!.candidate as { intent: string }).intent).toBe(SECRET);
  });

  it('writes nothing into the vault directory', () => {
    // The whole vault tree, not just `personas/<p>/pending/` — a store that moved to some OTHER
    // path inside the vault would satisfy a check that only looked where the old one lived, and
    // would still be committed by the next write.
    const files = execFileSync('git', ['-C', fx.dir, 'ls-files'], { encoding: 'utf8' });
    expect(files).not.toMatch(/pending/);
    expect(existsSync(join(fx.dir, 'personas', fx.personas[0]!, 'pending'))).toBe(false);
  });

  it('makes no commit at all — a queued guess is not an event in the record', () => {
    const subjects = execFileSync('git', ['-C', fx.dir, 'log', '--format=%s'], { encoding: 'utf8' });
    expect(subjects).not.toMatch(/pending/);
  });

  it('and the plaintext is in no git object, which is the claim that actually matters', () => {
    // `git ls-files` shows the working tree; this reads every blob the repository holds. It is
    // the check the old implementation would have failed even after `deletePending`, and the one
    // a path assertion cannot make on its own.
    const objects = execFileSync('git', ['-C', fx.dir, 'rev-list', '--objects', '--all'], {
      encoding: 'utf8',
    });
    const hits = objects
      .split('\n')
      .map((line) => line.split(' ')[0])
      .filter((sha): sha is string => Boolean(sha) && /^[0-9a-f]{40}$/.test(sha))
      .filter((sha) => {
        const type = execFileSync('git', ['-C', fx.dir, 'cat-file', '-t', sha], { encoding: 'utf8' }).trim();
        if (type !== 'blob') return false;
        const body = execFileSync('git', ['-C', fx.dir, 'cat-file', 'blob', sha], { encoding: 'utf8' });
        return body.includes(SECRET);
      });
    expect(hits).toEqual([]);
  });

  it('is sealed on disk, because permanence was the threat and not confidentiality', () => {
    // Moving the queue out of the vault answers "for ever". Giving up encryption while doing so
    // would answer it by trading one problem for another, so the store still seals with the
    // vault's content key — a stolen disk yields nothing more than it did before.
    const dir = join(fx.node.local.dir, 'pending', fx.personas[0]!);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const raw = execFileSync('cat', [join(dir, files[0]!)], { encoding: 'utf8' });
    expect(raw).not.toContain(SECRET);
    expect(JSON.parse(raw)).toMatchObject({ type: 'vault_record', kind: 'pending' });
  });

  it('and dismissing it removes it, with nothing left to recover', () => {
    fx.node.confirm({ id: pendingId, decision: 'dismiss' });
    expect(fx.node.local.getPending(fx.personas[0]!, pendingId)).toBeNull();
    const dir = join(fx.node.local.dir, 'pending', fx.personas[0]!);
    expect(readdirSync(dir)).toEqual([]);
  });
});
