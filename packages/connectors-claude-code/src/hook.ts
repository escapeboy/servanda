import { Rfc3339 } from '@servanda/types';
import type { Envelope } from '@servanda/types';
import { MAX_PAYLOAD_TEXT, MAX_REF, clip, compact, label, sealEnvelope } from './envelope.js';

/**
 * Claude Code session hook → §2 envelopes.
 *
 * A hook receives a JSON object on stdin (`hook_event_name`, `session_id`,
 * `transcript_path`, `cwd`, plus event-specific fields) and its stdout is fed back to the
 * session. That last part is why this module returns envelopes instead of printing them:
 * writing an envelope to stdout of a `UserPromptSubmit` hook would inject observation data
 * straight back into the model's context — M-6 inverted. The shipped bin appends to a log
 * file and stays silent.
 */

export const HOOK_KINDS = {
  UserPromptSubmit: 'session_utterance',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  Stop: 'session_turn_end',
} as const;

export type HookEventName = keyof typeof HOOK_KINDS;

export interface HookContext {
  /**
   * Hook payloads carry no timestamp of their own. The caller reads the clock ONCE at the
   * process boundary and passes it in, keeping the envelope path itself deterministic.
   */
  readonly occurredAt: string;
  readonly receivedAt: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Zero or one envelope. Unknown hook events, and events with no signal, yield nothing. */
export function envelopeFromHookEvent(
  event: unknown,
  persona: string,
  ctx: HookContext,
): Envelope | undefined {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) return undefined;
  const o = event as Record<string, unknown>;

  const name = o['hook_event_name'];
  if (typeof name !== 'string' || !(name in HOOK_KINDS)) return undefined;
  const kind = HOOK_KINDS[name as HookEventName];

  if (!Rfc3339.safeParse(ctx.occurredAt).success) return undefined;

  const prompt = str(o['prompt']);
  if (name === 'UserPromptSubmit' && prompt === undefined) return undefined;

  const transcriptPath = str(o['transcript_path']);
  const refs = transcriptPath !== undefined
    ? [{ kind: 'file' as const, value: clip(transcriptPath, MAX_REF) }]
    : [];

  return sealEnvelope({
    v: 'servanda/0.1',
    type: 'envelope',
    source: 'transcript',
    kind,
    occurred_at: ctx.occurredAt,
    received_at: ctx.receivedAt,
    actor: { label: label(name === 'UserPromptSubmit' ? 'user' : 'session') },
    payload: compact({
      hook_event: name,
      session_id: str(o['session_id']),
      cwd: str(o['cwd']),
      permission_mode: str(o['permission_mode']),
      // SessionStart carries `source` (startup|resume|clear|compact); SessionEnd `reason`.
      session_source: str(o['source']),
      end_reason: str(o['reason']),
      role: name === 'UserPromptSubmit' ? 'user' : undefined,
      text: prompt === undefined ? undefined : clip(prompt, MAX_PAYLOAD_TEXT),
      text_length: prompt === undefined ? undefined : prompt.length,
    }),
    refs,
    persona,
  });
}
