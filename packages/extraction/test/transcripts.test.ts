import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Envelope } from '@servanda/types';
import { harnessPersona, scanTranscripts } from '../src/index.js';
import { transcriptFixture, userLine } from './fixtures.js';

const NOW = new Date('2026-07-25T12:00:00Z');

describe('transcript scanner (read-only §2 ingress)', () => {
  const lines = [
    userLine('I will finish the migration guide and send it to Maria by Friday.'),
    '{ this line is not json at all',
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: "I'll do it" }] } }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-07-20T09:05:00Z',
      sessionId: 's',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
    }),
    JSON.stringify({
      type: 'user',
      isMeta: true,
      timestamp: '2026-07-20T09:06:00Z',
      sessionId: 's',
      message: { role: 'user', content: 'meta noise that is long enough to pass the floor' },
    }),
    userLine('short', '2026-07-20T09:07:00Z'),
    '',
    userLine('<command-name>/clear</command-name> and more text to clear the length floor'),
    userLine('Ivan said he would review the PR before the release.', '2026-07-20T09:08:00Z'),
  ];

  it('produces one envelope per human utterance and skips the rest', () => {
    const root = transcriptFixture(lines);
    const result = scanTranscripts({ root, now: NOW, days: 30 });

    expect(result.stats.transcriptsFound).toBe(1);
    expect(result.stats.linesMalformed).toBe(1);
    expect(result.envelopes).toHaveLength(2);
    for (const envelope of result.envelopes) {
      expect(() => Envelope.parse(envelope)).not.toThrow();
      expect(envelope.source).toBe('transcript');
      expect(envelope.kind).toBe('session_utterance');
      expect(envelope.persona).toBe(harnessPersona());
    }
  });

  it('never writes to the transcript tree', () => {
    const root = transcriptFixture(lines);
    const file = join(root, '-tmp-fixture', 'session-1.jsonl');
    const before = { mtime: statSync(file).mtimeMs, bytes: readFileSync(file, 'utf8') };

    scanTranscripts({ root, now: NOW, days: 30 });

    const after = { mtime: statSync(file).mtimeMs, bytes: readFileSync(file, 'utf8') };
    expect(after.bytes).toBe(before.bytes);
    expect(after.mtime).toBe(before.mtime);
  });

  it('honours the time window', () => {
    const root = transcriptFixture(lines);
    const stale = scanTranscripts({ root, now: new Date('2027-01-01T00:00:00Z'), days: 30 });
    expect(stale.stats.transcriptsFound).toBe(0);
    expect(stale.envelopes).toHaveLength(0);
  });

  it('honours the envelope cap and says the scan was truncated', () => {
    const root = transcriptFixture(lines);
    const capped = scanTranscripts({ root, now: NOW, days: 30, maxEnvelopes: 1 });
    expect(capped.envelopes).toHaveLength(1);
    expect(capped.stats.truncated).toBe(true);
  });

  it('gives every envelope the id §2 requires — sha256 of its canonical form sans id', () => {
    const root = transcriptFixture(lines);
    const result = scanTranscripts({ root, now: NOW, days: 30 });
    for (const envelope of result.envelopes) {
      expect(envelope.id).toMatch(/^[0-9a-f]{64}$/);
      expect(result.sources.get(envelope.id)?.file).toContain('session-1.jsonl');
    }
    const ids = new Set(result.envelopes.map((e) => e.id));
    expect(ids.size).toBe(result.envelopes.length);
  });

  it('excludes subagent transcripts and counts the exclusion (M-13: an agent is never a party)', () => {
    const root = transcriptFixture(lines);
    const subagents = join(root, '-tmp-fixture', 'session-uuid', 'subagents');
    mkdirSync(subagents, { recursive: true });
    writeFileSync(
      join(subagents, 'agent-worker.jsonl'),
      `${userLine('I will refactor the parser and report back when done.')}\n`,
      'utf8',
    );

    const result = scanTranscripts({ root, now: NOW, days: 30 });
    expect(result.stats.subagentTranscriptsSkipped).toBe(1);
    expect(result.stats.transcriptsFound).toBe(1);
    for (const source of result.sources.values()) {
      expect(source.file).not.toContain('subagents');
    }
  });

  it('returns nothing when the transcript root does not exist', () => {
    const result = scanTranscripts({ root: '/nonexistent/servanda/transcripts', now: NOW });
    expect(result.envelopes).toHaveLength(0);
    expect(result.stats.transcriptsFound).toBe(0);
  });
});
