import type { EvidenceRef } from '@servanda/types';

/**
 * The evidence-ref grammar.
 *
 * §3.1 gives `evidence_refs` as `{ kind: 'envelope'|'url'|'commit'|'file', value: string }` and
 * says nothing about the shape of `value`. That is a spec gap, and this file is the narrowest
 * reading of it: rather than let an adapter interpret a free string — a string whose ultimate
 * origin is an untrusted signal (§9.2) — each kind gets a closed grammar, and a value that does
 * not fit is REFUSED (`malformed-evidence-ref`), never guessed at.
 *
 * REPORTED AMBIGUITY: this grammar is invented here. It is the only part of the adapter layer
 * that is not derivable from the spec, and it is deliberately kept in one file so it can be
 * replaced wholesale if the protocol ever fixes a canonical form.
 *
 *   commit  "<7..40 hex>"                 the commit is present in the repository
 *           "branch:<name>"               the branch exists; the head sha is recorded
 *           "merged:<head-ref>..<base>"   head-ref is an ancestor of base (a merged PR, locally)
 *   file    "<relative/path>"             the path exists; its digest is recorded
 *           "<relative/path>#sha256=<64 hex>"   ...and is compared to the named digest
 *   envelope "<64 hex>"                   the id of a §2 envelope already received
 *   url     —                             no grammar: observing one needs the network
 */

export type ParsedCommitRef =
  | { readonly kind: 'commit'; readonly commit: string }
  | { readonly kind: 'branch'; readonly branch: string }
  | { readonly kind: 'merged'; readonly head: string; readonly base: string };

export type ParsedFileRef = {
  readonly path: string;
  readonly expectedSha256: string | null;
};

export class MalformedRef extends Error {
  constructor(readonly ref: EvidenceRef, why: string) {
    super(`malformed ${ref.kind} evidence ref: ${why}`);
    this.name = 'MalformedRef';
  }
}

const HEX_COMMIT = /^[0-9a-f]{7,40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * A git ref name, narrowed well past what git itself accepts. Everything that git treats as an
 * operator or an option — `-` at the front, `..`, `@{`, `~`, `^`, `:`, `?`, `*`, `[`, a
 * backslash, whitespace — is simply not in the alphabet, so a ref name can never turn into an
 * argument. `--` is passed on every invocation as well (see `git.ts`); this is the belt.
 */
const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

function assertRefName(ref: EvidenceRef, name: string): string {
  if (!REF_NAME.test(name)) throw new MalformedRef(ref, `${JSON.stringify(name)} is not a ref name`);
  if (name.includes('..')) throw new MalformedRef(ref, 'a ref name may not contain ".."');
  if (name.endsWith('.lock')) throw new MalformedRef(ref, 'a ref name may not end in ".lock"');
  return name;
}

export function parseCommitRef(ref: EvidenceRef): ParsedCommitRef {
  const value = ref.value.trim();
  if (value.length === 0) throw new MalformedRef(ref, 'empty');

  if (value.startsWith('branch:')) {
    return { kind: 'branch', branch: assertRefName(ref, value.slice('branch:'.length)) };
  }
  if (value.startsWith('merged:')) {
    const range = value.slice('merged:'.length);
    const parts = range.split('..');
    if (parts.length !== 2) throw new MalformedRef(ref, 'expected "merged:<head>..<base>"');
    const [head, base] = parts as [string, string];
    return { kind: 'merged', head: assertRefName(ref, head), base: assertRefName(ref, base) };
  }
  if (HEX_COMMIT.test(value)) return { kind: 'commit', commit: value };
  throw new MalformedRef(ref, 'expected a hex commit, "branch:<name>" or "merged:<head>..<base>"');
}

/**
 * Normalize a workspace-relative path, refusing anything that could leave the root.
 *
 * Deliberately a local copy of the rule in `@servanda/executors`' `normalizeWorkspacePath`
 * rather than an import: this is a containment boundary, and a boundary that depends on another
 * containment boundary's package for its guard has one more way to be widened by accident. A
 * `..` never resolves, so there is no window in which a traversal is briefly a valid path.
 */
export function normalizeRelativePath(ref: EvidenceRef, path: string): string {
  if (path.length === 0) throw new MalformedRef(ref, 'empty path');
  if (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path)) {
    throw new MalformedRef(ref, 'path must be relative to the workspace root');
  }
  if (path.includes('\\')) throw new MalformedRef(ref, 'path must use "/"');
  if (path.includes('\0')) throw new MalformedRef(ref, 'path must not contain a NUL byte');
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') throw new MalformedRef(ref, 'path must not traverse upward');
    segments.push(segment);
  }
  if (segments.length === 0) throw new MalformedRef(ref, 'path resolves to nothing');
  return segments.join('/');
}

export function parseFileRef(ref: EvidenceRef): ParsedFileRef {
  const value = ref.value.trim();
  const hashIndex = value.indexOf('#');
  if (hashIndex < 0) {
    return { path: normalizeRelativePath(ref, value), expectedSha256: null };
  }
  const path = value.slice(0, hashIndex);
  const suffix = value.slice(hashIndex + 1);
  if (!suffix.startsWith('sha256=')) {
    throw new MalformedRef(ref, 'the only supported digest suffix is "#sha256=<64 hex>"');
  }
  const digest = suffix.slice('sha256='.length);
  if (!SHA256_HEX.test(digest)) throw new MalformedRef(ref, 'digest must be 64 lowercase hex');
  return { path: normalizeRelativePath(ref, path), expectedSha256: digest };
}

export function parseEnvelopeRef(ref: EvidenceRef): string {
  const value = ref.value.trim();
  if (!SHA256_HEX.test(value)) throw new MalformedRef(ref, 'an envelope id is 64 lowercase hex');
  return value;
}
