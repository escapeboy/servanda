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
 * `gc.auto=0`, and it is not a performance tweak.
 *
 * git forks a DETACHED background `gc --auto` after commits, which keeps writing into
 * `.git/objects` after the synchronous command has returned. For a vault that is the wrong
 * behaviour on its own terms — a library-managed store should not mutate itself while its owner
 * believes it is idle — and it is also what made teardown flaky on CI: `rmSync` raced the
 * background process and threw `ENOTEMPTY: rmdir '.git/objects'` from `afterAll`, failing a whole
 * test file in which every assertion had passed.
 *
 * Retries were the first remedy and they treated the symptom; this removes the process that
 * races. A vault is small and append-only, so nothing here needs collecting behind our back.
 */
const GIT_CONFIG = ['-c', 'gc.auto=0'];

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
