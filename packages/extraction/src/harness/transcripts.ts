import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { hashCanonical, sha256Hex, utf8 } from '@servanda/crypto';
import { Envelope, PROTOCOL_VERSION } from '@servanda/types';

/**
 * A read-only transcript connector for the precision harness.
 *
 * It reads `~/.claude/projects/**\/*.jsonl` and nothing else, and it only ever reads: no file
 * under that tree is created, modified, or deleted. Everything it produces is a §2 envelope —
 * the node's private observation log — and envelope content is data, never instruction (M-6).
 *
 * Parsing is deliberately forgiving of the file format and unforgiving of its content: a line
 * that will not parse is counted and skipped, never repaired or guessed at.
 */

export const DEFAULT_PROJECTS_ROOT = join(homedir(), '.claude', 'projects');

/**
 * A synthetic persona for the harness. The harness holds no keys and touches no vault, but a §2
 * envelope requires a `persona`, and M-5 requires that the value mean something — so it is
 * derived deterministically from a label and used consistently for the whole run.
 */
export function harnessPersona(label = 'local-user'): string {
  return sha256Hex(utf8(`servanda/harness/persona:${label}`));
}

export interface Utterance {
  readonly text: string;
  readonly occurredAt: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly project: string;
  readonly file: string;
  readonly line: number;
}

export interface ReadStats {
  linesRead: number;
  linesMalformed: number;
  utterances: number;
}

/**
 * Content the CLI injects into the user turn. A "user" record in a transcript is not the same
 * thing as a person speaking: slash-command expansions, command stdout, and — the big one —
 * subagent task notifications all arrive on the user turn wrapped in machine tags. Extracting
 * from those attributes an agent's report to a human, which M-13 says is never a party's promise.
 *
 * This filter was written after a dry run: without it, the large majority of extractions came
 * from `<result>` blocks in agent notifications rather than from anything a person wrote.
 */
const INJECTED_PREFIXES = [
  '<system-reminder>',
  '<command-name>',
  '<local-command-stdout>',
  '<command-message>',
  'Caveat: The messages below were generated',
];

/**
 * Machine content anywhere in the turn, not just at its start. The two that matter most are
 * subagent task notifications (`<result>`) and relayed messages from other agents
 * (`<teammate-message>`): both put an agent's "I'll do X" on the user turn, and M-13 is clear
 * that automation acts under a persona, never as one. Extracting from them would attribute an
 * agent's undertaking to the human — the precise failure the harness exists to make visible.
 */
const MACHINE_MARKERS = [
  '<result>',
  '<usage>',
  '<worktree>',
  '<task-notification',
  '<subagent_tokens>',
  '<function_results>',
  '<tool_use_error>',
  '<local-command-stdout>',
  '<command-name>',
  '<teammate-message',
  'Another Claude session sent a message:',
  '<user-prompt-submit-hook>',
];

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

const MIN_UTTERANCE_CHARS = 20;
const MAX_UTTERANCE_CHARS = 8000;

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') return null;
    const type = (block as { type?: unknown }).type;
    // A list containing a tool_result is the transcript's plumbing, not an utterance.
    if (type !== 'text') return null;
    const text = (block as { text?: unknown }).text;
    if (typeof text !== 'string') return null;
    parts.push(text);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function cleanUtterance(raw: string): string | null {
  const stripped = raw.replace(SYSTEM_REMINDER, '').trim();
  if (stripped.length < MIN_UTTERANCE_CHARS) return null;
  if (INJECTED_PREFIXES.some((marker) => stripped.startsWith(marker))) return null;
  if (MACHINE_MARKERS.some((marker) => stripped.includes(marker))) return null;
  return stripped.length > MAX_UTTERANCE_CHARS ? stripped.slice(0, MAX_UTTERANCE_CHARS) : stripped;
}

/**
 * Read the human turns out of one transcript. Malformed lines are counted and skipped.
 */
export function readUtterances(
  file: string,
  stats: ReadStats,
  limit = Number.POSITIVE_INFINITY,
): Utterance[] {
  let contents: string;
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const project = basename(dirname(file));
  const out: Utterance[] = [];
  const lines = contents.split('\n');
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const line = lines[i];
    if (line === undefined || line.length === 0) continue;
    stats.linesRead++;
    // A JSONL line that is not a whole object is corrupt, whatever it would have contained.
    // Checked before the prefilter below so truncated lines are counted, not silently passed over.
    const trimmed = line.trimEnd();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
      stats.linesMalformed++;
      continue;
    }
    // Cheap prefilter: only user turns can be utterances, and the files are mostly not that.
    // Full JSON.parse on every line of a multi-gigabyte window is not worth what it would add.
    if (!line.includes('"type":"user"')) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      stats.linesMalformed++;
      continue;
    }
    if (record === null || typeof record !== 'object') {
      stats.linesMalformed++;
      continue;
    }
    const r = record as Record<string, unknown>;
    if (r['type'] !== 'user' || r['isMeta'] === true || r['isSidechain'] === true) continue;
    const message = r['message'];
    if (message === null || typeof message !== 'object') continue;
    const text = textOf((message as Record<string, unknown>)['content']);
    if (text === null) continue;
    const cleaned = cleanUtterance(text);
    if (cleaned === null) continue;
    const occurredAt = typeof r['timestamp'] === 'string' ? r['timestamp'] : null;
    if (occurredAt === null) continue;
    out.push({
      text: cleaned,
      occurredAt,
      sessionId: typeof r['sessionId'] === 'string' ? r['sessionId'] : 'unknown',
      cwd: typeof r['cwd'] === 'string' ? r['cwd'] : 'unknown',
      project,
      file,
      line: i + 1,
    });
    stats.utterances++;
  }
  return out;
}

/** Keep the head of an utterance; see DEFAULT_MAX_UTTERANCE_CHARS for why the tail is dropped. */
export function clipText(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/** §2 envelope. `id` is the sha256 of the canonical form sans id. */
export function toEnvelope(
  utterance: Utterance,
  persona: string,
  receivedAt: string,
  maxUtteranceChars: number = DEFAULT_MAX_UTTERANCE_CHARS,
): Envelope {
  const unidentified = {
    v: PROTOCOL_VERSION,
    type: 'envelope' as const,
    source: 'transcript',
    kind: 'session_utterance',
    occurred_at: normalizeRfc3339(utterance.occurredAt),
    received_at: receivedAt,
    actor: { label: 'local-user', external_id: utterance.sessionId },
    payload: {
      text: clipText(utterance.text, maxUtteranceChars),
      // Preserved so a reader can see the clip happened and how much was dropped, rather than
      // silently judging a truncated utterance as if it were whole.
      ...(utterance.text.length > maxUtteranceChars && maxUtteranceChars > 0
        ? { text_clipped_from: utterance.text.length }
        : {}),
      cwd: utterance.cwd,
      project: utterance.project,
      line: utterance.line,
    },
    refs: [{ kind: 'file' as const, value: `${utterance.file}#L${utterance.line}` }],
    persona,
  };
  return Envelope.parse({ ...unidentified, id: hashCanonical(unidentified) });
}

/** The transcripts carry millisecond precision; §00 accepts it, but keep one shape throughout. */
export function normalizeRfc3339(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Transcripts of subagent runs. Their "user" turns are one agent prompting another, not a person
 * speaking — and M-13 is explicit that agents are never parties. Excluded, and counted, so the
 * exclusion is visible in the report rather than an accident of how deep the walk goes.
 */
export const SUBAGENT_DIR = 'subagents';

export interface TranscriptIndex {
  readonly files: string[];
  readonly subagentFilesSkipped: number;
}

export function findTranscripts(root: string, sinceMs: number): TranscriptIndex {
  const files: string[] = [];
  let subagentFilesSkipped = 0;

  const walk = (dir: string, insideSubagents: boolean): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue; // unreadable: skip, it is not evidence of anything
      }
      if (stat.isDirectory()) {
        walk(path, insideSubagents || entry === SUBAGENT_DIR);
        continue;
      }
      if (!entry.endsWith('.jsonl')) continue;
      if (stat.mtimeMs < sinceMs) continue;
      if (insideSubagents) {
        subagentFilesSkipped++;
        continue;
      }
      files.push(path);
    }
  };

  walk(root, false);
  files.sort();
  return { files, subagentFilesSkipped };
}

/**
 * How much of one utterance is worth paying to send.
 *
 * Measured on a real 30-day corpus: the median utterance is 123 characters, but the top decile
 * runs to thousands — pasted logs, and machine-authored role prompts addressed to an agent.
 * Those long tails carried 76% of the corpus's characters and produced zero extractions, because
 * an instruction to an agent is not a promise by a person (M-13 makes the same point about who
 * can be a party).
 *
 * A promise is a sentence. Clipping the tail leaves the first paragraph — where a stated
 * intention nearly always is — and removes most of the cost and most of the noise. Set to 0 to
 * disable.
 */
export const DEFAULT_MAX_UTTERANCE_CHARS = 1000;

export interface ScanOptions {
  readonly root?: string;
  /** Characters of each utterance sent for extraction; 0 disables clipping. */
  readonly maxUtteranceChars?: number;
  readonly days?: number;
  readonly persona?: string;
  readonly maxTranscripts?: number;
  readonly maxUtterancesPerTranscript?: number;
  readonly maxEnvelopes?: number;
  readonly now?: Date;
}

export interface ScanResult {
  readonly persona: string;
  readonly envelopes: readonly Envelope[];
  readonly sources: ReadonlyMap<string, Utterance>;
  readonly stats: {
    readonly root: string;
    readonly days: number;
    readonly since: string;
    readonly transcriptsFound: number;
    readonly transcriptsScanned: number;
    /** Subagent transcripts deliberately excluded: an agent is never a party (M-13). */
    readonly subagentTranscriptsSkipped: number;
    readonly linesRead: number;
    readonly linesMalformed: number;
    readonly utterances: number;
    /** Replayed turns from resumed/forked sessions: the same observation, seen again. */
    readonly duplicatesSkipped: number;
    readonly envelopes: number;
    readonly truncated: boolean;
  };
}

export function scanTranscripts(options: ScanOptions = {}): ScanResult {
  const maxUtteranceChars = options.maxUtteranceChars ?? DEFAULT_MAX_UTTERANCE_CHARS;
  const root = options.root ?? DEFAULT_PROJECTS_ROOT;
  const days = options.days ?? 30;
  const persona = options.persona ?? harnessPersona();
  const now = options.now ?? new Date();
  const sinceMs = now.getTime() - days * 86_400_000;
  const receivedAt = normalizeRfc3339(now.toISOString());
  const maxEnvelopes = options.maxEnvelopes ?? Number.POSITIVE_INFINITY;
  const perFile = options.maxUtterancesPerTranscript ?? Number.POSITIVE_INFINITY;

  const index = findTranscripts(root, sinceMs);
  const found = index.files;
  const files =
    options.maxTranscripts !== undefined && options.maxTranscripts > 0
      ? found.slice(0, options.maxTranscripts)
      : found;

  const stats: ReadStats = { linesRead: 0, linesMalformed: 0, utterances: 0 };
  const envelopes: Envelope[] = [];
  const sources = new Map<string, Utterance>();
  // Resumed and forked sessions replay earlier turns verbatim into a new transcript. The same
  // utterance observed twice is one observation, not two — deduplicated here so it is counted
  // and reported once.
  const seen = new Set<string>();
  let duplicates = 0;
  let scanned = 0;
  let truncated = files.length < found.length;

  for (const file of files) {
    if (envelopes.length >= maxEnvelopes) {
      truncated = true;
      break;
    }
    scanned++;
    for (const utterance of readUtterances(file, stats, perFile)) {
      if (envelopes.length >= maxEnvelopes) {
        truncated = true;
        break;
      }
      const key = `${utterance.occurredAt} ${utterance.text}`;
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      const envelope = toEnvelope(utterance, persona, receivedAt, maxUtteranceChars);
      if (sources.has(envelope.id)) continue;
      envelopes.push(envelope);
      sources.set(envelope.id, utterance);
    }
  }

  return {
    persona,
    envelopes,
    sources,
    stats: {
      root,
      days,
      since: normalizeRfc3339(new Date(sinceMs).toISOString()),
      transcriptsFound: found.length,
      transcriptsScanned: scanned,
      subagentTranscriptsSkipped: index.subagentFilesSkipped,
      linesRead: stats.linesRead,
      linesMalformed: stats.linesMalformed,
      utterances: stats.utterances,
      duplicatesSkipped: duplicates,
      envelopes: envelopes.length,
      truncated,
    },
  };
}
