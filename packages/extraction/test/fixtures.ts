import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashCanonical, sha256Hex, utf8 } from '@servanda/crypto';
import { Envelope, PROTOCOL_VERSION } from '@servanda/types';

export const PERSONA_A = sha256Hex(utf8('test-persona-a'));
export const PERSONA_B = sha256Hex(utf8('test-persona-b'));
export const PERSONA_C = sha256Hex(utf8('test-persona-c'));

export function envelope(text: string, persona: string, occurredAt = '2026-07-01T10:00:00Z'): Envelope {
  const unidentified = {
    v: PROTOCOL_VERSION,
    type: 'envelope' as const,
    source: 'transcript',
    kind: 'session_utterance',
    occurred_at: occurredAt,
    received_at: '2026-07-25T10:00:00Z',
    actor: { label: 'local-user' },
    payload: { text },
    refs: [],
    persona,
  };
  return Envelope.parse({ ...unidentified, id: hashCanonical(unidentified) });
}

/** A transcript tree shaped like ~/.claude/projects, for the read-only scanner. */
export function transcriptFixture(lines: string[], project = '-tmp-fixture'): string {
  const root = mkdtempSync(join(tmpdir(), 'servanda-extraction-'));
  const dir = join(root, project);
  mkdirSync(dir);
  writeFileSync(join(dir, 'session-1.jsonl'), `${lines.join('\n')}\n`, 'utf8');
  return root;
}

export function userLine(text: string, timestamp = '2026-07-20T09:00:00.123Z'): string {
  return JSON.stringify({
    type: 'user',
    uuid: `u-${text.length}-${timestamp}`,
    timestamp,
    sessionId: 'sess-1',
    cwd: '/Users/tester/htdocs/thing',
    message: { role: 'user', content: text },
  });
}
