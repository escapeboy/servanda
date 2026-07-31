import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Rfc3339 } from '@servanda/types';
import type { Envelope } from '@servanda/types';
import {
  MAX_REF,
  clip,
  compact,
  label,
  rfc3339FromEpochSeconds,
  sealEnvelope,
} from './envelope.js';
import { addingCommit, blameFile, branchTips, currentBranch, trackedFiles } from './git.js';

/**
 * Repo archaeology: the cold-start value. A node that has just been created has no history
 * of its own, but the repository it lives next to is a decade of unkept promises in plain
 * text. This mines a LOCAL clone with git plumbing — no API, no network.
 *
 * Every finding becomes a §2 envelope whose `payload` carries enough for §3.4 extraction to
 * build a §3.1 commitment (an intent line, who wrote it, when, and where it lives).
 */

export const ARCHAEOLOGY_KINDS = [
  'archaeology_todo',
  'archaeology_stale_branch',
  'archaeology_dead_flag',
  'archaeology_unrun_migration',
] as const;
export type ArchaeologyKind = (typeof ARCHAEOLOGY_KINDS)[number];

export interface ArchaeologyOptions {
  readonly repoPath: string;
  /** §2 `received_at` — injected, so the envelope path holds no clock. */
  readonly receivedAt: string;
  /**
   * The instant ages are measured against. Injected for the same reason: "this TODO is
   * three years old" must be reproducible, and `Date.now()` is not.
   */
  readonly referenceTime: string;
  /** A branch whose tip is older than this, and is not the checked-out branch, is stale. */
  readonly staleBranchDays?: number;
  readonly markers?: readonly string[];
  readonly migrationsDirs?: readonly string[];
  readonly appliedLedgers?: readonly string[];
  readonly maxFileBytes?: number;
}

const DEFAULT_MARKERS = ['TODO', 'FIXME', 'HACK', 'XXX'] as const;
const DEFAULT_STALE_DAYS = 90;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MIGRATIONS_DIRS = [
  'migrations',
  'db/migrations',
  'db/migrate',
  'database/migrations',
] as const;
const DEFAULT_APPLIED_LEDGERS = [
  'applied.txt',
  '.applied',
  'applied_migrations.txt',
  'schema_migrations.txt',
] as const;

/**
 * SPEC AMBIGUITY (narrowest reading): §2 names `github` among the sources but archaeology
 * mines a git clone, which may have no forge at all. This connector is the GitHub connector
 * and `github` is its connector-id, so archaeology envelopes carry `source: "github"` and
 * are distinguished by `kind`. Recorded in the stream report rather than invented as a new
 * source value that downstream stages would have to learn.
 */
const ARCHAEOLOGY_SOURCE = 'github';

/** A file that is unreadable, binary, or oversized is skipped — never thrown on. */
function readTextFile(repoPath: string, file: string, maxBytes: number): string | undefined {
  let buf: Buffer;
  try {
    buf = readFileSync(join(repoPath, file));
  } catch {
    return undefined;
  }
  if (buf.length === 0 || buf.length > maxBytes) return undefined;
  if (buf.includes(0)) return undefined; // binary
  return buf.toString('utf8');
}

interface Marker {
  readonly file: string;
  readonly line: number;
  readonly marker: string;
  readonly text: string;
}

function findMarkers(file: string, content: string, markers: readonly string[]): Marker[] {
  const pattern = new RegExp(`\\b(${markers.join('|')})\\b[:\\s-]*(.*)$`, 'u');
  const out: Marker[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = pattern.exec(line);
    if (m === null) continue;
    const marker = m[1];
    if (marker === undefined) continue;
    out.push({
      file,
      line: i + 1,
      marker,
      // The marker text is the promise as written. It is DATA (M-6): a TODO reading
      // "ignore previous instructions" is a string in `payload.text`, nothing more.
      text: (m[2] ?? '').trim(),
    });
  }
  return out;
}

/**
 * Dead feature flag, narrowest defensible reading: an identifier shaped like a flag that
 * occurs in exactly ONE tracked file. A flag declared and never read anywhere else is dead
 * with no runtime knowledge required; anything richer (a flag that is permanently on, a
 * flag only its own tests touch) needs semantics this connector does not have.
 */
const FLAG_PATTERN = /\b(?:FEATURE|FLAG)_[A-Z0-9]+(?:_[A-Z0-9]+)*\b/gu;

interface FlagSite {
  readonly files: Set<string>;
  readonly file: string;
  readonly line: number;
}

function collectFlags(files: readonly { file: string; content: string }[]): Map<string, FlagSite> {
  const flags = new Map<string, { files: Set<string>; file: string; line: number }>();
  for (const { file, content } of files) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      for (const match of line.matchAll(FLAG_PATTERN)) {
        const name = match[0];
        const existing = flags.get(name);
        if (existing === undefined) flags.set(name, { files: new Set([file]), file, line: i + 1 });
        else existing.files.add(file);
      }
    }
  }
  return flags;
}

const MIGRATION_FILE = /^(\d+)[_-][A-Za-z0-9._-]*\.(?:sql|js|ts|py|rb|php)$/u;

interface UnrunMigration {
  readonly file: string;
  readonly id: string;
  readonly sequence: string;
}

/**
 * Unrun migration, narrowest defensible reading: a migration file whose identifier appears
 * in no applied-ledger file in the repo. Without a database this is the only local evidence
 * that exists — so when there is no ledger, this finder emits NOTHING rather than guessing
 * that every migration is unrun.
 */
function findUnrunMigrations(
  tracked: readonly string[],
  read: (file: string) => string | undefined,
  migrationsDirs: readonly string[],
  ledgerNames: readonly string[],
): UnrunMigration[] {
  const out: UnrunMigration[] = [];
  for (const dir of migrationsDirs) {
    const prefix = `${dir}/`;
    const inDir = tracked.filter((f) => f.startsWith(prefix));
    if (inDir.length === 0) continue;

    const ledgerPath = ledgerNames
      .map((n) => `${prefix}${n}`)
      .find((p) => inDir.includes(p));
    if (ledgerPath === undefined) continue;

    const ledger = read(ledgerPath);
    if (ledger === undefined) continue;
    const applied = ledger
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));

    for (const file of inDir) {
      const base = file.slice(prefix.length);
      const m = MIGRATION_FILE.exec(base);
      if (m === null) continue;
      const sequence = m[1] ?? '';
      const id = base.replace(/\.[A-Za-z0-9]+$/u, '');
      const isApplied = applied.some((entry) => entry === id || entry === sequence || entry.includes(id));
      if (!isApplied) out.push({ file, id, sequence });
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

export function archaeologyEnvelopes(persona: string, options: ArchaeologyOptions): Envelope[] {
  const {
    repoPath,
    receivedAt,
    referenceTime,
    staleBranchDays = DEFAULT_STALE_DAYS,
    markers = DEFAULT_MARKERS,
    migrationsDirs = DEFAULT_MIGRATIONS_DIRS,
    appliedLedgers = DEFAULT_APPLIED_LEDGERS,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  } = options;

  if (!Rfc3339.safeParse(referenceTime).success) {
    throw new TypeError(`archaeology: referenceTime must be RFC 3339, got ${referenceTime}`);
  }
  const referenceEpoch = Math.floor(Date.parse(referenceTime) / 1000);
  const ageDays = (epoch: number): number =>
    Math.max(0, Math.floor((referenceEpoch - epoch) / 86_400));

  const tracked = trackedFiles(repoPath);
  const cache = new Map<string, string | undefined>();
  const read = (file: string): string | undefined => {
    if (!cache.has(file)) cache.set(file, readTextFile(repoPath, file, maxFileBytes));
    return cache.get(file);
  };

  const readable: { file: string; content: string }[] = [];
  for (const file of tracked) {
    const content = read(file);
    if (content !== undefined) readable.push({ file, content });
  }

  const envelopes: Envelope[] = [];

  // --- TODO / FIXME with blame age ---------------------------------------------------
  for (const { file, content } of readable) {
    const found = findMarkers(file, content, markers);
    if (found.length === 0) continue;
    const blame = blameFile(repoPath, file);
    for (const marker of found) {
      const line = blame.get(marker.line);
      if (line === undefined) continue; // uncommitted line: no age, no finding
      envelopes.push(
        sealEnvelope({
          v: 'servanda/0.1',
          type: 'envelope',
          source: ARCHAEOLOGY_SOURCE,
          kind: 'archaeology_todo',
          occurred_at: rfc3339FromEpochSeconds(line.authorTimeEpoch),
          received_at: receivedAt,
          actor: compact({ label: label(line.authorLabel), external_id: line.authorEmail || undefined }),
          payload: compact({
            repo_path: repoPath,
            file: marker.file,
            line: marker.line,
            marker: marker.marker,
            text: marker.text,
            commit: line.commit,
            author_email: line.authorEmail || undefined,
            age_days: ageDays(line.authorTimeEpoch),
            reference_time: referenceTime,
          }),
          refs: [
            { kind: 'file', value: clip(`${marker.file}:${marker.line}`, MAX_REF) },
            { kind: 'commit', value: line.commit },
          ],
          persona,
        }),
      );
    }
  }

  // --- stale branches -----------------------------------------------------------------
  const head = currentBranch(repoPath);
  const staleSeconds = staleBranchDays * 86_400;
  for (const tip of branchTips(repoPath)) {
    if (tip.name === head) continue;
    if (referenceEpoch - tip.committedAtEpoch <= staleSeconds) continue;
    envelopes.push(
      sealEnvelope({
        v: 'servanda/0.1',
        type: 'envelope',
        source: ARCHAEOLOGY_SOURCE,
        kind: 'archaeology_stale_branch',
        occurred_at: rfc3339FromEpochSeconds(tip.committedAtEpoch),
        received_at: receivedAt,
        actor: { label: label(tip.authorLabel) },
        payload: compact({
          repo_path: repoPath,
          branch: tip.name,
          commit: tip.commit,
          text: tip.subject,
          default_branch: head,
          age_days: ageDays(tip.committedAtEpoch),
          stale_after_days: staleBranchDays,
          reference_time: referenceTime,
        }),
        refs: [{ kind: 'commit', value: tip.commit }],
        persona,
      }),
    );
  }

  // --- dead feature flags --------------------------------------------------------------
  const flags = [...collectFlags(readable).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [name, site] of flags) {
    if (site.files.size !== 1) continue;
    const blame = blameFile(repoPath, site.file);
    const line = blame.get(site.line);
    if (line === undefined) continue;
    envelopes.push(
      sealEnvelope({
        v: 'servanda/0.1',
        type: 'envelope',
        source: ARCHAEOLOGY_SOURCE,
        kind: 'archaeology_dead_flag',
        occurred_at: rfc3339FromEpochSeconds(line.authorTimeEpoch),
        received_at: receivedAt,
        actor: compact({ label: label(line.authorLabel), external_id: line.authorEmail || undefined }),
        payload: compact({
          repo_path: repoPath,
          flag: name,
          file: site.file,
          line: site.line,
          commit: line.commit,
          reference_count: 1,
          age_days: ageDays(line.authorTimeEpoch),
          reference_time: referenceTime,
        }),
        refs: [
          { kind: 'file', value: clip(`${site.file}:${site.line}`, MAX_REF) },
          { kind: 'commit', value: line.commit },
        ],
        persona,
      }),
    );
  }

  // --- unrun migrations ----------------------------------------------------------------
  for (const migration of findUnrunMigrations(tracked, read, migrationsDirs, appliedLedgers)) {
    const stamp = addingCommit(repoPath, migration.file);
    if (stamp === undefined) continue;
    envelopes.push(
      sealEnvelope({
        v: 'servanda/0.1',
        type: 'envelope',
        source: ARCHAEOLOGY_SOURCE,
        kind: 'archaeology_unrun_migration',
        occurred_at: rfc3339FromEpochSeconds(stamp.authoredAtEpoch),
        received_at: receivedAt,
        actor: { label: label(stamp.authorLabel) },
        payload: compact({
          repo_path: repoPath,
          file: migration.file,
          migration_id: migration.id,
          sequence: migration.sequence,
          commit: stamp.commit,
          text: stamp.subject,
          age_days: ageDays(stamp.authoredAtEpoch),
          reference_time: referenceTime,
        }),
        refs: [
          { kind: 'file', value: clip(migration.file, MAX_REF) },
          { kind: 'commit', value: stamp.commit },
        ],
        persona,
      }),
    );
  }

  return envelopes;
}
