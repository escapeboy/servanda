import { execFileSync } from 'node:child_process';

/**
 * Git plumbing. No network, ever: archaeology is the cold-start path and must work on a
 * laptop on a plane (§8 M-10 is about the protocol, but the same rule earns the value here).
 *
 * The user's global and system git config are neutralized. A stray `core.quotepath`,
 * `blame.*`, or `log.date` setting would change this connector's output on one machine and
 * not another, and determinism is the gate.
 */
export function git(repoPath: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    },
  });
}

/** Tracked paths, NUL-delimited so no path ever needs unquoting, then sorted. */
export function trackedFiles(repoPath: string): string[] {
  return git(repoPath, ['ls-files', '-z']).split('\0').filter((p) => p.length > 0).sort();
}

export function currentBranch(repoPath: string): string {
  return git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}

export interface BranchTip {
  readonly name: string;
  readonly commit: string;
  readonly committedAtEpoch: number;
  readonly subject: string;
  readonly authorLabel: string;
}

export function branchTips(repoPath: string): BranchTip[] {
  const format = '%(refname:short)\t%(objectname)\t%(committerdate:unix)\t%(authorname)\t%(contents:subject)';
  const out: BranchTip[] = [];
  for (const line of git(repoPath, ['for-each-ref', `--format=${format}`, '--sort=refname', 'refs/heads']).split('\n')) {
    if (line.trim().length === 0) continue;
    const [name, commit, epoch, authorLabel, ...subject] = line.split('\t');
    if (name === undefined || commit === undefined || epoch === undefined) continue;
    const committedAtEpoch = Number.parseInt(epoch, 10);
    if (!Number.isFinite(committedAtEpoch)) continue;
    out.push({
      name,
      commit,
      committedAtEpoch,
      authorLabel: authorLabel ?? '',
      subject: subject.join('\t'),
    });
  }
  return out;
}

export interface BlameLine {
  readonly commit: string;
  readonly authorLabel: string;
  readonly authorEmail: string;
  readonly authorTimeEpoch: number;
}

/**
 * One `--line-porcelain` blame per file, indexed by 1-based final line number. Blaming the
 * whole file once rather than per marker keeps a file with twelve TODOs at one subprocess.
 */
export function blameFile(repoPath: string, file: string): Map<number, BlameLine> {
  const out = new Map<number, BlameLine>();
  let raw: string;
  try {
    raw = git(repoPath, ['blame', '--line-porcelain', '--', file]);
  } catch {
    return out;
  }
  let commit = '';
  let authorLabel = '';
  let authorEmail = '';
  let authorTimeEpoch = 0;
  let finalLine = 0;
  for (const line of raw.split('\n')) {
    const header = /^([0-9a-f]{40}) \d+ (\d+)/u.exec(line);
    if (header !== null) {
      commit = header[1] ?? '';
      finalLine = Number.parseInt(header[2] ?? '0', 10);
      continue;
    }
    if (line.startsWith('author ')) authorLabel = line.slice('author '.length);
    else if (line.startsWith('author-mail ')) authorEmail = line.slice('author-mail '.length).replace(/^<|>$/gu, '');
    else if (line.startsWith('author-time ')) authorTimeEpoch = Number.parseInt(line.slice('author-time '.length), 10);
    else if (line.startsWith('\t') && finalLine > 0) {
      out.set(finalLine, { commit, authorLabel, authorEmail, authorTimeEpoch });
    }
  }
  return out;
}

export interface CommitStamp {
  readonly commit: string;
  readonly authorLabel: string;
  readonly authoredAtEpoch: number;
  readonly subject: string;
}

/** The commit that ADDED a path (`--diff-filter=A`), which is what "unrun since" means. */
export function addingCommit(repoPath: string, file: string): CommitStamp | undefined {
  let raw: string;
  try {
    raw = git(repoPath, ['log', '--diff-filter=A', '-1', '--format=%H%x09%an%x09%at%x09%s', '--', file]);
  } catch {
    return undefined;
  }
  const line = raw.split('\n')[0];
  if (line === undefined || line.trim().length === 0) return undefined;
  const [commit, authorLabel, epoch, ...subject] = line.split('\t');
  if (commit === undefined || epoch === undefined) return undefined;
  const authoredAtEpoch = Number.parseInt(epoch, 10);
  if (!Number.isFinite(authoredAtEpoch)) return undefined;
  return {
    commit,
    authorLabel: authorLabel ?? '',
    authoredAtEpoch,
    subject: subject.join('\t'),
  };
}
