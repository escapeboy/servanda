import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DraftPrArtifact } from '../artifact.js';
import type { ExecutionOutcome, FileChangeRecord } from '../artifact.js';
import { assertPermitted, DiffBudgetError, matchesGlob, normalizeWorkspacePath } from '../capabilities.js';
import type { CapabilitySet } from '../capabilities.js';
import { unifiedDiff } from '../diff.js';
import type { ExecutionTarget, ExecutorCommitment } from '../executor.js';
import { getExecutorClass } from '../registry.js';
import {
  AUTO_APPLY_WINDOW_HOURS,
  ceilingFor,
  effectiveAutonomy,
  emptyTrustRecord,
} from '../trust/gradient.js';
import type { TrustRecord } from '../trust/gradient.js';
import { RESPONSE_PREFIX, SandboxResponse } from './protocol.js';
import { PROTOCOL_VERSION } from '@servanda/types';

/**
 * The host side of the sandbox: prepares the world, runs the executor in it, and refuses to
 * trust what comes back.
 *
 * The important sequence is:
 *   1. **Select** — only files matching the class's `read` capability are loaded. Everything
 *      else is not "blocked"; it never enters the process.
 *   2. **Spawn** — a child under the network/subprocess trap, with a scrubbed environment. The
 *      parent's env is *not* inherited: whatever `GITHUB_TOKEN` or `AWS_SECRET_ACCESS_KEY` this
 *      process holds, the executor's world contains no such thing.
 *   3. **Re-validate** — every proposed write is checked against the `write` capability again,
 *      here, by the host. The in-sandbox `Workspace` check is the executor's guardrail; this one
 *      is the host's, and it is the one that counts, because the host does not trust the child.
 *   4. **Assemble** — the host builds the artifact. The executor cannot set `draft`, name a base
 *      commit, or attribute a signature, because it never touches this object.
 *
 * Nothing here writes to the repository. The artifact is data.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** dist/sandbox/run.js → package root; src/sandbox/run.ts → package root. Same relative depth. */
const PACKAGE_ROOT = join(HERE, '..', '..');
export const DENY_NETWORK_PRELOAD = join(PACKAGE_ROOT, 'sandbox', 'deny-network.cjs');
export const SANDBOX_HOST_ENTRY = join(PACKAGE_ROOT, 'dist', 'sandbox', 'host.js');

/**
 * The environment an executor process gets. Not the parent's, filtered — this, instead of it.
 * One key, and it is a marker. `GITHUB_TOKEN`, `NPM_TOKEN`, `AWS_SECRET_ACCESS_KEY` and every
 * other thing the host happens to hold are not "hidden" from the executor; they are absent from
 * the world it runs in (security.md §2: "they are not in its world").
 */
export const SANDBOX_ENV: Readonly<Record<string, string>> = Object.freeze({
  SERVANDA_SANDBOX: '1',
});

/**
 * The exact spawn parameters of a sandboxed executor, in one place, so that the containment
 * proof can run a canary through the *same* code path rather than a re-creation of it. A proof
 * that tests a copy of the sandbox proves something about the copy.
 */
export function sandboxSpawnArgs(entry: string = SANDBOX_HOST_ENTRY): {
  command: string;
  args: string[];
  options: { env: Record<string, string>; cwd: string; stdio: ['pipe', 'pipe', 'pipe'] };
} {
  return {
    command: process.execPath,
    args: ['--require', DENY_NETWORK_PRELOAD, entry],
    options: {
      env: { ...SANDBOX_ENV },
      cwd: PACKAGE_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  };
}

export const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_SNAPSHOT_FILES = 2000;
const MAX_FILE_BYTES = 512 * 1024;

export class SandboxError extends Error {
  override name = 'SandboxError';
}

export interface RepoRef {
  /** Absolute path to the repository the executor works against. Read-only, always. */
  readonly path: string;
  readonly baseBranch?: string;
}

export interface RunExecutorOptions {
  readonly executorClass: string;
  readonly commitment: ExecutorCommitment;
  readonly target: ExecutionTarget;
  readonly persona: string;
  readonly repo: RepoRef;
  /** History for (persona, class). Absent means: no history, so the floor. */
  readonly trust?: TrustRecord;
  /** M-8: `null` means no verification adapter, which never auto-escalates. */
  readonly edgeVerifiable?: boolean | null;
  /**
   * The human's own words, for the artifact body. Passed here and not into the sandbox on
   * purpose: §9.2 keeps free text out of executor contexts, but the reviewer needs to see what
   * they said. The host quotes it; the executor never reads it.
   */
  readonly intentForReviewer?: string;
  readonly now?: string;
  readonly timeoutMs?: number;
}

/** Walk the working tree, skipping `.git`, taking only what the read capability admits. */
export function snapshotRepo(repoPath: string, capabilities: CapabilitySet): Record<string, string> {
  if (!existsSync(repoPath)) throw new SandboxError(`no such repository: ${repoPath}`);
  const snapshot: Record<string, string> = {};
  let count = 0;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(repoPath, absolute).split(sep).join('/');
      let normalized: string;
      try {
        normalized = normalizeWorkspacePath(rel);
      } catch {
        continue;
      }
      if (!capabilities.read.some((glob) => matchesGlob(normalized, glob))) continue;
      if (statSync(absolute).size > MAX_FILE_BYTES) continue;
      if (++count > MAX_SNAPSHOT_FILES) {
        throw new SandboxError(`repository has more than ${MAX_SNAPSHOT_FILES} readable files`);
      }
      snapshot[normalized] = readFileSync(absolute, 'utf8');
    }
  };

  walk(repoPath);
  return snapshot;
}

/**
 * Read the checked-out commit by reading git's files. Deliberately not `git rev-parse`: the
 * host resolves this so the executor never needs a subprocess, and so nothing in this package
 * ever executes git.
 */
export function readHead(repoPath: string): { commit: string; branch: string } {
  let gitDir = join(repoPath, '.git');
  if (!existsSync(gitDir)) throw new SandboxError(`not a git repository: ${repoPath}`);
  // In a worktree (and in a submodule) `.git` is a FILE holding `gitdir: <path>`, not a directory.
  // Reading HEAD out of it then failed with a raw ENOTDIR from the platform — an error that names
  // no repository and suggests no cause, out of a package whose whole point is that it never
  // shells out to git. `--worktree` is how this repo's own agents are told to work, so the case is
  // not exotic.
  if (statSync(gitDir).isFile()) {
    const pointer = readFileSync(gitDir, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/.exec(pointer);
    if (!match) throw new SandboxError(`.git is a file but names no gitdir: ${repoPath}`);
    gitDir = resolve(repoPath, match[1]!.trim());
    if (!existsSync(gitDir)) throw new SandboxError(`.git points at a missing gitdir: ${gitDir}`);
  }
  const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
  if (!head.startsWith('ref: ')) return { commit: head, branch: 'HEAD' };
  const ref = head.slice('ref: '.length).trim();
  const branch = ref.replace(/^refs\/heads\//, '');
  const looseRef = join(gitDir, ...ref.split('/'));
  if (existsSync(looseRef)) return { commit: readFileSync(looseRef, 'utf8').trim(), branch };
  const packed = join(gitDir, 'packed-refs');
  if (existsSync(packed)) {
    for (const line of readFileSync(packed, 'utf8').split('\n')) {
      const [sha, name] = line.trim().split(' ');
      if (name === ref && sha !== undefined) return { commit: sha, branch };
    }
  }
  throw new SandboxError(`cannot resolve ${ref} in ${repoPath}`);
}

async function runSandbox(request: unknown, timeoutMs: number): Promise<SandboxResponse> {
  if (!existsSync(SANDBOX_HOST_ENTRY)) {
    throw new SandboxError(
      `${SANDBOX_HOST_ENTRY} does not exist. Build first: npx tsc -b packages/executors`,
    );
  }
  return new Promise<SandboxResponse>((resolve, reject) => {
    const { command, args, options } = sandboxSpawnArgs();
    const child = spawn(command, args, options);

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new SandboxError(`executor exceeded its ${timeoutMs}ms budget`));
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new SandboxError(`could not start the sandbox: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = stdout.split('\n').find((l) => l.startsWith(RESPONSE_PREFIX));
      if (line === undefined) {
        reject(
          new SandboxError(
            `sandbox produced no response (exit ${code}): ${stderr.slice(0, 400) || stdout.slice(0, 400)}`,
          ),
        );
        return;
      }
      try {
        resolve(SandboxResponse.parse(JSON.parse(line.slice(RESPONSE_PREFIX.length))));
      } catch (err) {
        reject(new SandboxError(`sandbox response did not validate: ${String(err)}`));
      }
    });

    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
  });
}

function addHours(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export async function runExecutor(options: RunExecutorOptions): Promise<ExecutionOutcome> {
  const executorClass = getExecutorClass(options.executorClass);
  const now = options.now ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  if (options.target.kind !== executorClass.targetKind) {
    return {
      kind: 'refused',
      executorClass: executorClass.name,
      reason: `class ${executorClass.name} takes a ${executorClass.targetKind} target, got ${options.target.kind}`,
    };
  }

  const snapshot = snapshotRepo(options.repo.path, executorClass.capabilities);
  const head = readHead(options.repo.path);

  const response = await runSandbox(
    {
      executor_class: executorClass.name,
      commitment: options.commitment,
      target: options.target,
      persona: options.persona,
      now,
      snapshot,
    },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!response.ok) {
    return {
      kind: 'refused',
      executorClass: executorClass.name,
      reason: `${response.error.name}: ${response.error.message}`,
    };
  }
  if (response.output === null) {
    return {
      kind: 'nothing-to-do',
      executorClass: executorClass.name,
      reason: 'the executor found nothing it could safely propose',
    };
  }

  // ── the host re-validates everything the child proposed ────────────────────────────────
  const changes: FileChangeRecord[] = [];
  const diffs: string[] = [];
  let changedLines = 0;

  for (const [path, contents] of Object.entries(response.proposal.writes)) {
    const normalized = assertPermitted(executorClass.capabilities, 'write', path);
    const before = snapshot[normalized] ?? null;
    const diff = unifiedDiff(normalized, before, contents);
    if (diff.additions === 0 && diff.deletions === 0) continue;
    changes.push({
      path: normalized,
      kind: before === null ? 'added' : 'modified',
      additions: diff.additions,
      deletions: diff.deletions,
    });
    diffs.push(diff.text);
    changedLines += diff.additions + diff.deletions;
  }
  for (const path of response.proposal.deletes) {
    const normalized = assertPermitted(executorClass.capabilities, 'write', path);
    const before = snapshot[normalized];
    if (before === undefined) continue;
    const diff = unifiedDiff(normalized, before, null);
    changes.push({ path: normalized, kind: 'deleted', additions: 0, deletions: diff.deletions });
    diffs.push(diff.text);
    changedLines += diff.deletions;
  }

  if (changes.length === 0) {
    return {
      kind: 'nothing-to-do',
      executorClass: executorClass.name,
      reason: 'the executor returned a title but changed nothing',
    };
  }
  if (changes.length > executorClass.capabilities.maxChangedFiles) {
    throw new DiffBudgetError('changed-files', changes.length, executorClass.capabilities.maxChangedFiles);
  }
  if (changedLines > executorClass.capabilities.maxChangedLines) {
    throw new DiffBudgetError('changed-lines', changedLines, executorClass.capabilities.maxChangedLines);
  }

  // ── autonomy: measured, capped, and never escalated by an unverifiable edge ─────────────
  const record = options.trust ?? emptyTrustRecord(options.persona, executorClass.name, now);
  const ceiling = ceilingFor(
    executorClass.riskClass,
    changes.map((c) => c.path),
  );
  const autonomy = effectiveAutonomy({
    record,
    ceiling,
    edgeVerifiable: options.edgeVerifiable ?? null,
  });

  const body = [
    response.output.body,
    '',
    '---',
    '',
    options.intentForReviewer !== undefined
      ? `Serves the commitment: “${options.intentForReviewer}”`
      : `Serves commitment \`${options.commitment.commitment_hash}\`.`,
    `Produced by executor class \`${executorClass.name}\` acting under persona ` +
      `\`${options.persona.slice(0, 12)}…\`. Automation is never a party (M-13): this artifact ` +
      'is unsigned and nothing has been applied.',
    `Autonomy for this (human, class): **${autonomy.level}**` +
      (autonomy.cappedBy === null
        ? ''
        : ` — capped by ${autonomy.cappedBy} from an earned ${autonomy.earned}`) +
      '.',
  ].join('\n');

  const artifact = DraftPrArtifact.parse({
    v: PROTOCOL_VERSION,
    type: 'draft_pr_artifact',
    executor_class: executorClass.name,
    risk_class: executorClass.riskClass,
    commitment_hash: options.commitment.commitment_hash,
    acting_under: options.persona,
    signed_by: null,
    draft: true,
    base: {
      repo_path: options.repo.path,
      base_commit: head.commit,
      base_branch: options.repo.baseBranch ?? head.branch,
    },
    branch: `servanda/${executorClass.name}/${options.commitment.commitment_hash.slice(0, 12)}`,
    title: response.output.title,
    body,
    changes,
    diff: diffs.join(''),
    capabilities: {
      read: [...executorClass.capabilities.read],
      write: [...executorClass.capabilities.write],
      max_changed_lines: executorClass.capabilities.maxChangedLines,
      max_changed_files: executorClass.capabilities.maxChangedFiles,
    },
    autonomy: {
      level: autonomy.level,
      earned: autonomy.earned,
      ceiling: autonomy.ceiling,
      capped_by: autonomy.cappedBy,
      applies_at:
        autonomy.level === 'auto-apply-with-window' ? addHours(now, AUTO_APPLY_WINDOW_HOURS) : null,
    },
    created_at: now,
  });

  return { kind: 'artifact', artifact };
}
