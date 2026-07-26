import { z } from 'zod';

/**
 * §9.2 / security.md §2 — "capabilities, not prohibitions".
 *
 * An executor is not told what it may not do. It is handed a world, and everything outside that
 * world does not exist for it: not "you may not send email" but "there is no network interface".
 * This file is the enumeration of that world.
 *
 * Two properties are structural rather than checked:
 *   - There is no `network` capability. Not `network: false` — no field. A capability set cannot
 *     express network access, so no executor can be granted it and no future edit can quietly
 *     add it to a class without changing this type.
 *   - There is no `env`, `secrets`, `exec`, or `signing_key` capability either, for the same
 *     reason. A silent-mode test executor still cannot touch CI secrets because they are not in
 *     its world (security.md §2).
 *
 * What remains is: which paths it may read, which it may write, and how large a change it may
 * propose.
 */

/** A path pattern, relative to the workspace root. `*` matches within a segment, `**` across. */
export const PathGlob = z.string().min(1);

export const CapabilitySet = z
  .object({
    /** Files the executor may read. Nothing outside this is even loaded into its process. */
    read: z.array(PathGlob).min(1),
    /** Files the executor may write or delete. Enforced twice: in the sandbox, and on return. */
    write: z.array(PathGlob),
    /** Upper bound on the size of the proposed change, in changed lines (§9.2 "diff upper bound"). */
    maxChangedLines: z.number().int().positive(),
    /** Upper bound on how many files one artifact may touch. */
    maxChangedFiles: z.number().int().positive(),
  })
  .strict();
export type CapabilitySet = z.infer<typeof CapabilitySet>;

export class CapabilityError extends Error {
  constructor(
    readonly path: string,
    readonly mode: 'read' | 'write',
    readonly allowed: readonly string[],
  ) {
    super(
      `§9.2: ${mode} of ${JSON.stringify(path)} is outside this executor's capability world ` +
        `(${mode} = ${allowed.map((g) => JSON.stringify(g)).join(', ')})`,
    );
    this.name = 'CapabilityError';
  }
}

export class DiffBudgetError extends Error {
  constructor(what: string, got: number, limit: number) {
    super(`§9.2: proposed change exceeds its ${what} budget: ${got} > ${limit}`);
    this.name = 'DiffBudgetError';
  }
}

/**
 * Reject anything that could leave the workspace before it is ever matched against a glob.
 * A path that escapes the root is not a capability question — it is a malformed path.
 */
export function normalizeWorkspacePath(path: string): string {
  if (path.length === 0) throw new TypeError('workspace path must not be empty');
  if (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path)) {
    throw new TypeError(`workspace path must be relative, got: ${path}`);
  }
  if (path.includes('\\')) throw new TypeError(`workspace path must use "/", got: ${path}`);
  if (path.includes('\0')) throw new TypeError('workspace path must not contain a NUL byte');
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      // Not "resolve and then check": a `..` never resolves, so there is no window in which a
      // traversal is briefly a valid path.
      throw new TypeError(`workspace path must not traverse upward, got: ${path}`);
    }
    segments.push(segment);
  }
  if (segments.length === 0) throw new TypeError(`workspace path resolves to nothing: ${path}`);
  return segments.join('/');
}

/** Glob match over already-normalized paths. `**` crosses separators, `*` does not. */
export function matchesGlob(path: string, glob: string): boolean {
  const pattern = glob
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      switch (part) {
        case '**/':
          return '(?:[^/]+/)*';
        case '**':
          return '.*';
        case '*':
          return '[^/]*';
        case '?':
          return '[^/]';
        default:
          return part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }
    })
    .join('');
  return new RegExp(`^${pattern}$`).test(path);
}

export function permits(capabilities: CapabilitySet, mode: 'read' | 'write', path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  return capabilities[mode].some((glob) => matchesGlob(normalized, glob));
}

export function assertPermitted(
  capabilities: CapabilitySet,
  mode: 'read' | 'write',
  path: string,
): string {
  const normalized = normalizeWorkspacePath(path);
  if (!capabilities[mode].some((glob) => matchesGlob(normalized, glob))) {
    throw new CapabilityError(path, mode, capabilities[mode]);
  }
  return normalized;
}
