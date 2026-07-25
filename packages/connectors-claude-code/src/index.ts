import { PersonaId } from '@servanda/types';
import type { Envelope } from '@servanda/types';
import type { HookContext } from './hook.js';
import { envelopeFromHookEvent } from './hook.js';
import type { TranscriptContext } from './transcript.js';
import {
  envelopesFromTranscript,
  envelopesFromTranscriptDir,
  envelopesFromTranscriptFile,
} from './transcript.js';

export * from './envelope.js';
export * from './hook.js';
export * from './transcript.js';

/**
 * §2 / M-5: "a connector instance is bound to exactly one persona at registration."
 *
 * The persona is a constructor argument and never a method argument, so there is no call
 * site at which an envelope could be minted for a different persona — mixing org contexts
 * requires constructing a second connector, which is the point.
 */
export class ClaudeCodeConnector {
  readonly persona: string;

  constructor(options: { readonly persona: string }) {
    this.persona = PersonaId.parse(options.persona);
  }

  /** Raw JSONL content (one Claude Code transcript). */
  fromTranscript(content: string, ctx: TranscriptContext): Envelope[] {
    return envelopesFromTranscript(content, this.persona, ctx);
  }

  /** A single `~/.claude/projects/<slug>/<session>.jsonl`. Read-only. */
  fromTranscriptFile(path: string, ctx: Omit<TranscriptContext, 'transcriptPath'>): Envelope[] {
    return envelopesFromTranscriptFile(path, this.persona, ctx);
  }

  /** A whole `~/.claude/projects` tree, traversed in sorted order. Read-only. */
  fromTranscriptDir(dir: string, ctx: Omit<TranscriptContext, 'transcriptPath'>): Envelope[] {
    return envelopesFromTranscriptDir(dir, this.persona, ctx);
  }

  /** One Claude Code hook payload (the JSON object delivered on the hook's stdin). */
  fromHookEvent(event: unknown, ctx: HookContext): Envelope[] {
    const envelope = envelopeFromHookEvent(event, this.persona, ctx);
    return envelope === undefined ? [] : [envelope];
  }
}
