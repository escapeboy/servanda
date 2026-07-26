import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@servanda/types';
import type { EvidenceRef } from '@servanda/types';
import type { AdapterCommitment, ObservationContext, VerificationAdapter } from '../adapter.js';
import { notVerifiable, observed } from '../adapter.js';
import type { Observation } from '../bundle.js';
import { MalformedRef, parseCommitRef } from '../refs.js';

/**
 * The `git` adapter: does this commit, branch, or merge exist?
 *
 * This is the one adapter that runs a program, and the containment is in what it *can* run.
 *
 *  - **A closed allowlist of plumbing.** `rev-parse`, `cat-file`, `merge-base`. None of the
 *    three can transfer an object, contact a remote, write a ref, or run a hook. There is no
 *    `fetch`, no `clone`, no `ls-remote`, no `submodule`, and `runGit` refuses anything not on
 *    the list rather than trusting that no call site will ask (see `test/musts/M-13.test.ts`).
 *  - **No shell, ever.** `spawnSync` with an argv array and `shell: false`, so a ref value is an
 *    argument and can never become a command. `--end-of-options` stops an operand being read as
 *    an option, and `refs.ts` has already refused any value containing a character git treats as
 *    an operator.
 *  - **A scrubbed environment.** The user's git config is replaced with `/dev/null`, so an
 *    `url.<base>.insteadOf`, a credential helper, or a proxy setting in the ambient environment
 *    cannot change what this adapter does. Terminal prompting and askpass are disabled, so a
 *    hypothetical remote operation blocks rather than waits for a human.
 *
 * The honest limitation, stated rather than hidden: the network trap in `test/support` traps the
 * Node process, not a child. What proves this child is offline is the allowlist plus the env
 * scrub, and the gate asserts both directly instead of taking them on faith.
 */

/** Local, read-only plumbing. Adding to this list is a reviewable change, not a configuration. */
export const GIT_ALLOWLIST = Object.freeze(['rev-parse', 'cat-file', 'merge-base'] as const);
export type GitSubcommand = (typeof GIT_ALLOWLIST)[number];

export class RefusedGitSubcommand extends Error {
  constructor(subcommand: string) {
    super(
      `refused git subcommand ${JSON.stringify(subcommand)}; verification adapters are ` +
        `read-only and offline, and the allowlist is exactly [${GIT_ALLOWLIST.join(', ')}]`,
    );
    this.name = 'RefusedGitSubcommand';
  }
}

export interface GitResult {
  status: number;
  stdout: string;
}

/** The single point at which this package invokes anything. */
export function runGit(repo: string, argv: readonly string[]): GitResult {
  const [subcommand] = argv;
  if (subcommand === undefined || !(GIT_ALLOWLIST as readonly string[]).includes(subcommand)) {
    throw new RefusedGitSubcommand(String(subcommand));
  }
  const result = spawnSync('git', ['-C', repo, '--no-optional-locks', ...argv], {
    encoding: 'utf8',
    shell: false,
    env: {
      PATH: process.env['PATH'] ?? '',
      // The user's global/system config must not reach a verification observation.
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      GIT_OPTIONAL_LOCKS: '0',
    },
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status ?? 1, stdout: (result.stdout ?? '').trim() };
}

function isGitRepo(path: string): boolean {
  try {
    if (!existsSync(path) || !statSync(path).isDirectory()) return false;
  } catch {
    return false;
  }
  // A worktree file rather than a directory is still a repository.
  return existsSync(join(path, '.git'));
}

function resolve(repo: string, rev: string): string | null {
  // `--end-of-options` (git 2.24+) is what guarantees the operand is read as a revision and
  // never as an option, whatever it starts with. `refs.ts` has already narrowed it; this is the
  // second lock on the same door.
  const r = runGit(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`]);
  return r.status === 0 && /^[0-9a-f]{40}$/.test(r.stdout) ? r.stdout : null;
}

export const gitAdapter: VerificationAdapter = {
  name: 'git',
  declares: ['commit'],
  summary: 'Observe that a commit, a branch, or a merge is present in a local repository.',

  observe(commitment: AdapterCommitment, ref: EvidenceRef, context: ObservationContext) {
    if (ref.kind !== 'commit') {
      return notVerifiable('no-adapter-for-evidence', `git does not observe ${ref.kind} refs`);
    }

    let parsed;
    try {
      parsed = parseCommitRef(ref);
    } catch (err) {
      if (err instanceof MalformedRef) return notVerifiable('malformed-evidence-ref', err.message);
      throw err;
    }

    const repo = context.repo?.path;
    if (repo === undefined) {
      return notVerifiable('adapter-capability-absent', 'no repository was provided to observe');
    }
    if (!isGitRepo(repo)) {
      return notVerifiable('adapter-capability-absent', `${repo} is not a git repository`);
    }

    let observation: Observation;
    switch (parsed.kind) {
      case 'commit': {
        const head = resolve(repo, parsed.commit);
        observation = {
          kind: 'git-commit',
          // The full sha when it resolved, so the bundle is not ambiguous about which commit
          // an abbreviation meant; the abbreviation itself is kept in `queried`.
          commit: head ?? '0'.repeat(40),
          queried: parsed.commit,
          present: head !== null,
        };
        break;
      }
      case 'branch': {
        const head = resolve(repo, `refs/heads/${parsed.branch}`);
        observation = {
          kind: 'git-branch',
          branch: parsed.branch,
          head,
          present: head !== null,
        };
        break;
      }
      case 'merged': {
        const head = resolve(repo, parsed.head);
        const base = resolve(repo, parsed.base);
        // "Merged" without a forge: the head is reachable from the base. `--is-ancestor` exits
        // 0 for yes and 1 for no, so an error status is neither and stays `false`.
        const merged =
          head !== null &&
          base !== null &&
          runGit(repo, ['merge-base', '--is-ancestor', head, base]).status === 0;
        observation = {
          kind: 'git-merged',
          head_ref: parsed.head,
          base_ref: parsed.base,
          head,
          base,
          merged,
        };
        break;
      }
    }

    const satisfied =
      observation.kind === 'git-merged' ? observation.merged : observation.present === true;

    return observed({
      v: PROTOCOL_VERSION,
      type: 'evidence_bundle',
      adapters: ['git'],
      commitment_hash: commitment.commitment_hash,
      observed_at: context.now,
      satisfied,
      observations: [observation],
    });
  },
};
