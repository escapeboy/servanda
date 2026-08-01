import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
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

/** Stage everything and commit. Returns the commit sha, or null when there was nothing to commit. */
export function commitAll(dir: string, message: string): string | null {
  assertVaultRepo(dir);
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
