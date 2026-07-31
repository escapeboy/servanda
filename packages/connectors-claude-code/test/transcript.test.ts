import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envelopeId } from '@servanda/crypto';
import { Envelope, UnidentifiedEnvelope } from '@servanda/types';
import { ClaudeCodeConnector } from '../src/index.js';

/**
 * The line shapes below were taken from real `~/.claude/projects/**\/*.jsonl` files, not
 * from documentation. The format is Claude Code's, not ours, so anything unrecognized is
 * skipped rather than thrown on.
 */

const PERSONA = '7'.repeat(64);
const RECEIVED = '2026-06-06T00:00:00Z';
const connector = new ClaudeCodeConnector({ persona: PERSONA });
const ctx = { receivedAt: RECEIVED };

const USER_LINE = JSON.stringify({
  parentUuid: null,
  isSidechain: false,
  type: 'user',
  message: { role: 'user', content: 'I will get the migration reviewed by Thursday.' },
  uuid: '11111111-1111-4111-8111-111111111111',
  timestamp: '2026-01-02T09:00:00.123Z',
  sessionId: 'sess-1',
  cwd: '/Users/dana/htdocs/api',
  gitBranch: 'main',
  version: '2.1.59',
});

const ASSISTANT_LINE = JSON.stringify({
  parentUuid: '11111111-1111-4111-8111-111111111111',
  isSidechain: false,
  type: 'assistant',
  message: {
    role: 'assistant',
    model: 'claude-opus-5',
    content: [
      { type: 'thinking', thinking: 'private reasoning that is not an utterance' },
      { type: 'text', text: 'Noted. I will open the PR first.' },
    ],
  },
  uuid: '22222222-2222-4222-8222-222222222222',
  timestamp: '2026-01-02T09:00:05.400Z',
  sessionId: 'sess-1',
  cwd: '/Users/dana/htdocs/api',
  gitBranch: 'main',
  version: '2.1.59',
});

const TOOL_ONLY_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }],
  },
  uuid: '33333333-3333-4333-8333-333333333333',
  timestamp: '2026-01-02T09:00:06.000Z',
  sessionId: 'sess-1',
});

const TRANSCRIPT = [
  JSON.stringify({ type: 'system', subtype: 'hook', uuid: 'sys-1', timestamp: '2026-01-02T08:59:59.000Z' }),
  USER_LINE,
  ASSISTANT_LINE,
  TOOL_ONLY_LINE,
  JSON.stringify({ type: 'mode', mode: 'default', sessionId: 'sess-1' }),
].join('\n');

describe('Claude Code transcripts become §2 envelopes', () => {
  it('emits one session_utterance per text-bearing message', () => {
    const envelopes = connector.fromTranscript(TRANSCRIPT, ctx);
    expect(envelopes.map((e) => [e.kind, e.actor.label, e.payload['text']])).toEqual([
      ['session_utterance', 'user', 'I will get the migration reviewed by Thursday.'],
      ['session_utterance', 'assistant', 'Noted. I will open the PR first.'],
    ]);
  });

  it('takes occurred_at from the source event and received_at from the caller', () => {
    const [first] = connector.fromTranscript(TRANSCRIPT, ctx);
    expect(first.occurred_at).toBe('2026-01-02T09:00:00.123Z');
    expect(first.received_at).toBe(RECEIVED);
    expect(first.source).toBe('transcript');
  });

  it('records session provenance in payload and the message uuid as a ref', () => {
    const [first] = connector.fromTranscript(TRANSCRIPT, ctx);
    expect(first.payload).toMatchObject({
      session_id: 'sess-1',
      message_uuid: '11111111-1111-4111-8111-111111111111',
      role: 'user',
      cwd: '/Users/dana/htdocs/api',
      git_branch: 'main',
      cli_version: '2.1.59',
      is_sidechain: false,
    });
    expect(first.refs).toEqual([
      { kind: 'message', value: '11111111-1111-4111-8111-111111111111' },
    ]);
  });

  it('excludes thinking blocks: private reasoning is not an utterance', () => {
    const assistant = connector.fromTranscript(ASSISTANT_LINE, ctx)[0];
    expect(assistant.payload['text']).toBe('Noted. I will open the PR first.');
    expect(JSON.stringify(assistant)).not.toContain('private reasoning');
  });

  it('emits nothing for a message with no text', () => {
    expect(connector.fromTranscript(TOOL_ONLY_LINE, ctx)).toEqual([]);
  });

  it('skips malformed lines instead of throwing', () => {
    const junk = [
      '{ not json',
      '',
      '   ',
      'null',
      '[]',
      '"a string"',
      '{"type":"user"}',
      '{"type":"user","message":{"role":"user","content":"hi"}}', // no timestamp
      '{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"yesterday","uuid":"u"}',
      '{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-01-02T09:00:00Z"}', // no uuid
      '{"type":"user","message":{"role":"user","content":""},"timestamp":"2026-01-02T09:00:00Z","uuid":"u"}',
      USER_LINE,
    ].join('\n');
    const envelopes = connector.fromTranscript(junk, ctx);
    expect(envelopes).toHaveLength(1);
    expect(() => Envelope.parse(envelopes[0])).not.toThrow();
  });

  it('is deterministic: the same transcript yields byte-identical envelopes', () => {
    expect(JSON.stringify(connector.fromTranscript(TRANSCRIPT, ctx))).toBe(
      JSON.stringify(connector.fromTranscript(TRANSCRIPT, ctx)),
    );
  });

  it('derives id as sha256 of the domain tag and the canonical form sans id', () => {
    for (const envelope of connector.fromTranscript(TRANSCRIPT, ctx)) {
      const { id, ...rest } = envelope;
      expect(id).toBe(envelopeId(UnidentifiedEnvelope.parse(rest)));
    }
  });

  it('deduplicates identical lines: a resumed session repeats them', () => {
    const doubled = [USER_LINE, USER_LINE, USER_LINE].join('\n');
    expect(connector.fromTranscript(doubled, ctx)).toHaveLength(1);
  });

  it('records the transcript path as a file ref when reading from disk', () => {
    const missing = connector.fromTranscriptFile('/nonexistent/session.jsonl', ctx);
    expect(missing).toEqual([]);
  });
});

/**
 * Opt-in scan over the machine's real transcripts: proves the shape assumptions against
 * data nobody wrote for this test. Excluded from gate GB, which must stay hermetic.
 * Enable with SERVANDA_SCAN_REAL_TRANSCRIPTS=1.
 */
const REAL = join(homedir(), '.claude', 'projects');
const scanEnabled = process.env['SERVANDA_SCAN_REAL_TRANSCRIPTS'] === '1' && existsSync(REAL);

describe.skipIf(!scanEnabled)('real local transcripts', () => {
  it('yields only valid §2 envelopes, deterministically', () => {
    const envelopes = connector.fromTranscriptDir(REAL, ctx);
    expect(envelopes.length).toBeGreaterThan(0);
    for (const envelope of envelopes) {
      expect(() => Envelope.parse(envelope)).not.toThrow();
      expect(envelope.persona).toBe(PERSONA);
      expect(envelope.source).toBe('transcript');
      expect(envelope.kind).toBe('session_utterance');
    }
    const again = connector.fromTranscriptDir(REAL, ctx);
    expect(again.map((e) => e.id)).toEqual(envelopes.map((e) => e.id));
  });
});
