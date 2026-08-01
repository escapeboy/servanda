import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Rfc3339 } from '@servanda/types';
import type { Envelope } from '@servanda/types';
import { MAX_LABEL, MAX_REF, clip, compact, label, sealEnvelope } from './envelope.js';

/**
 * Reader for Claude Code's local session transcripts (`~/.claude/projects/**\/*.jsonl`).
 *
 * The shape below was derived by inspecting real transcripts, not from documentation, so it
 * is treated as unstable: a line that does not match is SKIPPED, never thrown on. A
 * connector emits valid §2 envelopes or nothing.
 */

export interface TranscriptContext {
  /**
   * §2 `received_at` — the node's own clock. Injected rather than read here so the envelope
   * path contains no clock: the same transcript must produce byte-identical envelopes.
   */
  readonly receivedAt: string;
  /** Recorded as a `file` ref when the lines came from a known path. */
  readonly transcriptPath?: string;
}

interface ContentBlock {
  readonly type?: unknown;
  readonly text?: unknown;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue;
    const block = raw as ContentBlock;
    // `thinking` blocks are the model's private reasoning and `tool_use`/`tool_result`
    // blocks are machine traffic; neither is an utterance. Narrowest reading of §2's
    // `session_utterance`.
    if (block.type !== 'text' || typeof block.text !== 'string') continue;
    parts.push(block.text);
  }
  return parts.join('\n\n');
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * One transcript line to zero or one envelope.
 *
 * Zero for: unparseable JSON, a non-message line (`system`, `attachment`, `mode`, …), a
 * missing/invalid timestamp, a missing uuid, or an empty utterance.
 */
export function envelopeFromLine(
  line: string,
  persona: string,
  ctx: TranscriptContext,
): Envelope | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;

  if (o['type'] !== 'user' && o['type'] !== 'assistant') return undefined;

  const message = o['message'];
  if (typeof message !== 'object' || message === null) return undefined;
  const m = message as Record<string, unknown>;
  const role = m['role'];
  if (role !== 'user' && role !== 'assistant') return undefined;

  const occurredAt = str(o['timestamp']);
  if (occurredAt === undefined || !Rfc3339.safeParse(occurredAt).success) return undefined;

  const uuid = str(o['uuid']);
  if (uuid === undefined) return undefined;

  const text = textOf(m['content']);
  if (text.trim().length === 0) return undefined;

  // A transcript line is a file on disk that this connector did not write, so `model` is as
  // attacker-shaped as `content` is. Unclipped it lands in `actor.external_id`, which §2 gives no
  // bound and the envelope boundary therefore cannot reduce — a long enough one puts the whole
  // envelope over §2's canonical-form bound with no member left to shrink. `MAX_LABEL` is the
  // bound §2 states for the field beside it.
  const rawModel = role === 'assistant' ? str(m['model']) : undefined;
  const model = rawModel === undefined ? undefined : clip(rawModel, MAX_LABEL);

  const refs: { kind: 'message' | 'file'; value: string }[] = [
    { kind: 'message', value: clip(uuid, MAX_REF) },
  ];
  if (ctx.transcriptPath !== undefined) {
    refs.push({ kind: 'file', value: clip(ctx.transcriptPath, MAX_REF) });
  }

  return sealEnvelope({
    v: 'servanda/0.2',
    type: 'envelope',
    source: 'transcript',
    kind: 'session_utterance',
    occurred_at: occurredAt,
    received_at: ctx.receivedAt,
    actor: compact({ label: label(String(role)), external_id: model }),
    payload: compact({
      session_id: str(o['sessionId']),
      message_uuid: uuid,
      parent_uuid: str(o['parentUuid']),
      role,
      text,
      cwd: str(o['cwd']),
      git_branch: str(o['gitBranch']),
      cli_version: str(o['version']),
      is_sidechain: typeof o['isSidechain'] === 'boolean' ? o['isSidechain'] : undefined,
      agent_id: str(o['agentId']),
      model,
    }),
    refs,
    persona,
  });
}

/**
 * Deduplicates by envelope id. Claude Code repeats lines across resumed sessions, and two
 * lines that are equal in every observed field are one observation, not two.
 */
export function dedupe(envelopes: readonly Envelope[]): Envelope[] {
  const seen = new Set<string>();
  const out: Envelope[] = [];
  for (const e of envelopes) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

export function envelopesFromTranscript(
  content: string,
  persona: string,
  ctx: TranscriptContext,
): Envelope[] {
  const out: Envelope[] = [];
  for (const line of content.split('\n')) {
    if (line.trim().length === 0) continue;
    const envelope = envelopeFromLine(line, persona, ctx);
    if (envelope !== undefined) out.push(envelope);
  }
  return dedupe(out);
}

export function envelopesFromTranscriptFile(
  path: string,
  persona: string,
  ctx: Omit<TranscriptContext, 'transcriptPath'>,
): Envelope[] {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return envelopesFromTranscript(content, persona, { ...ctx, transcriptPath: path });
}

/** Sorted traversal: directory order is not stable across filesystems, envelope order is. */
export function transcriptFilesIn(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of [...entries].sort()) {
    const path = join(dir, entry);
    let s;
    try {
      s = statSync(path);
    } catch {
      continue;
    }
    if (s.isDirectory()) out.push(...transcriptFilesIn(path));
    else if (entry.endsWith('.jsonl')) out.push(path);
  }
  return out;
}

export function envelopesFromTranscriptDir(
  dir: string,
  persona: string,
  ctx: Omit<TranscriptContext, 'transcriptPath'>,
): Envelope[] {
  const out: Envelope[] = [];
  for (const file of transcriptFilesIn(dir)) {
    out.push(...envelopesFromTranscriptFile(file, persona, ctx));
  }
  return dedupe(out);
}
