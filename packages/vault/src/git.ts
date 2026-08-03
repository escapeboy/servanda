import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Git backing for the vault (ADR: the vault is its own repository, so every mutation is a
 * commit and history is recoverable).
 *
 * SAFETY: every command here runs with `cwd` set to a directory that has already been proved
 * to be the ROOT of its own git repository AND to carry the vault marker file. This code must
 * never be able to commit into the repository it is developed in — `assertVaultRepo` is what
 * makes that a checked property rather than a convention.
 */

export const VAULT_MARKER = 'servanda-vault.json';

export class VaultGitError extends Error {
  override name = 'VaultGitError';
}

/**
 * Two settings, and they are not a performance tweak. A library-managed store should not mutate
 * itself while its owner believes it is idle.
 *
 * After a commit, git forks a DETACHED background process that keeps writing into `.git/objects`
 * after the synchronous command has returned. On CI that raced `rmSync` and threw
 * `ENOTEMPTY: rmdir '.git/objects/pack'` from teardown, failing a whole test file in which every
 * assertion had passed.
 *
 * **`maintenance.auto=false` is the one that stops it.** Modern git does not fork `gc --auto`
 * directly; it forks `git maintenance run --auto`, and `maintenance.auto` is the switch for
 * whether that happens at all (git-config(1): "controls whether some commands run
 * `git maintenance run --auto` after doing their normal work"). `gc.auto=0` only tells the gc
 * TASK it has nothing to do — the process is still forked, still opens the repository, and still
 * touches `.git` on its way to deciding that. That is why an earlier fix setting `gc.auto=0`
 * alone held on a developer machine running git 2.33 and failed on CI's newer git.
 *
 * `gc.auto=0` stays: it is the guard for a maintenance run reached by any other route, and it
 * costs nothing. A vault is small and append-only, so nothing here needs collecting behind our
 * back either way.
 */
export const GIT_CONFIG = ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];

function git(dir: string, args: string[]): string {
  try {
    return execFileSync('git', [...GIT_CONFIG, ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new VaultGitError(`git ${args.join(' ')} failed in ${dir}: ${e.stderr ?? e.message}`);
  }
}

/**
 * Refuse to run git against anything but the vault's own repository root.
 * A vault directory nested inside another repo would otherwise silently commit to the parent.
 */
export function assertVaultRepo(dir: string): void {
  if (!existsSync(join(dir, VAULT_MARKER))) {
    throw new VaultGitError(`not a servanda vault (no ${VAULT_MARKER}): ${dir}`);
  }
  const top = git(dir, ['rev-parse', '--show-toplevel']).trim();
  if (realpathSync(top) !== realpathSync(dir)) {
    throw new VaultGitError(
      `refusing to operate: ${dir} is not the root of its own git repository (toplevel is ${top})`,
    );
  }
}

export function initVaultRepo(dir: string, author: { name: string; email: string }): void {
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  git(dir, ['config', 'user.name', author.name]);
  git(dir, ['config', 'user.email', author.email]);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

/**
 * The branch the vault is on, or null when HEAD is detached.
 *
 * Reading is fine at a detached HEAD — inspecting last month's register is a reasonable thing to
 * want, and `git checkout <sha>` is how a person does it. Writing is not: see `commitAll`.
 */
export function currentBranch(dir: string): string | null {
  // Read rather than ask. This runs on EVERY mutation, and a `git symbolic-ref` subprocess per
  // commit is a real cost in a store that already spends four of them there — enough to push the
  // federation convergence suite from 26 s to over its 30 s timeout, which is a test failing for
  // a reason that has nothing to do with what it tests. `.git/HEAD` is one line and it is the
  // file `symbolic-ref` reads.
  const head = join(dir, '.git', 'HEAD');
  if (statSync(join(dir, '.git'), { throwIfNoEntry: false })?.isDirectory() === true) {
    const ref = readFileSync(head, 'utf8').trim();
    return ref.startsWith('ref: refs/heads/') ? ref.slice('ref: refs/heads/'.length) : null;
  }
  // A linked worktree has a `.git` FILE, and then the branch is not ours to read directly.
  try {
    return git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Stage everything and commit. Returns the commit sha, or null when there was nothing to commit.
 *
 * Refuses at a detached HEAD, and this is a data-loss guard rather than tidiness. Somebody who
 * checked out an old commit to see what they had promised in June is looking at a register that is
 * missing everything since — and the software gives no sign of it, because a vault at an old commit
 * is a perfectly valid vault. If they then record a promise, it commits onto no branch: the next
 * `git checkout main` unreferences it, and the promise is gone from the working tree, gone from
 * every branch, and eventually collected. It was never anywhere a person would look.
 *
 * So the write stops and says where they are, which is also the only moment anything CAN say it.
 *
 * The record itself is already on disk when this fires — it is written, then committed — and it is
 * left there rather than rolled back. Rolling back would throw away the thing the person just
 * said, which is worse than any of this; an uncommitted file survives `git checkout main` and is
 * swept into the next commit. The message says so, because "it failed" would not be true.
 */
export function commitAll(dir: string, message: string): string | null {
  assertVaultRepo(dir);
  if (currentBranch(dir) === null) {
    throw new VaultGitError(
      `refusing to write: this vault's git checkout is at a detached HEAD, so what you are looking ` +
        `at is an old state of the vault and not all of it. A commit made here belongs to no branch ` +
        `and is lost at the next checkout. Nothing has been lost and what you just recorded is ` +
        `written but not yet committed: run \`git -C ${dir} checkout main\` to get your whole ` +
        `register back, and it will be kept along with the next thing you record. Use ` +
        `\`git -C ${dir} switch -c <name>\` instead to keep working from here on purpose.`,
    );
  }
  git(dir, ['add', '-A']);
  if (git(dir, ['status', '--porcelain']).trim() === '') return null;
  git(dir, ['commit', '--quiet', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

export function logMessages(dir: string): string[] {
  assertVaultRepo(dir);
  const out = git(dir, ['log', '--format=%s']).trim();
  return out === '' ? [] : out.split('\n');
}
