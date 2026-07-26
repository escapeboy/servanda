import { describe, expect, it } from 'vitest';
import { Envelope } from '@servanda/types';
import {
  DEFAULT_MAX_UTTERANCE_CHARS,
  clipText,
  toEnvelope,
  type Utterance,
} from '../src/harness/transcripts.js';

/**
 * Cost is a design constraint here, not an afterthought: the harness sends a month of transcripts
 * to a model, and on a real corpus the long tail carried 76% of the characters while producing
 * zero extractions.
 */

const utterance = (text: string): Utterance => ({
  text,
  occurredAt: '2026-07-01T10:00:00Z',
  sessionId: 'session-1',
  cwd: '/tmp',
  project: 'p',
  file: '/tmp/p.jsonl',
  line: 1,
});

describe('utterance clipping', () => {
  it('leaves a normal utterance untouched — the median is ~123 characters', () => {
    const text = "I'll add tests for PaymentRetryService once the release ships";
    expect(clipText(text, DEFAULT_MAX_UTTERANCE_CHARS)).toBe(text);
  });

  it('keeps the head, where a stated intention actually lives', () => {
    const promise = "I'll fix the invoice bug tomorrow. ";
    const clipped = clipText(promise + 'x'.repeat(50_000), 1000);
    expect(clipped.startsWith(promise)).toBe(true);
    expect(clipped.length).toBe(1001); // 1000 + the ellipsis marking the cut
  });

  it('marks the cut rather than hiding it', () => {
    expect(clipText('y'.repeat(2000), 1000).endsWith('…')).toBe(true);
  });

  it('can be disabled', () => {
    const long = 'z'.repeat(20_000);
    expect(clipText(long, 0)).toBe(long);
  });

  it('records the original length, so a reader knows the utterance was truncated', () => {
    const envelope = toEnvelope(utterance('a'.repeat(9000)), 'b'.repeat(64), '2026-07-01T10:00:01Z', 1000);
    expect(() => Envelope.parse(envelope)).not.toThrow();
    expect(envelope.payload['text_clipped_from']).toBe(9000);
    expect(String(envelope.payload['text']).length).toBe(1001);
  });

  it('does not claim a clip that did not happen', () => {
    const envelope = toEnvelope(utterance('short'), 'b'.repeat(64), '2026-07-01T10:00:01Z', 1000);
    expect(envelope.payload['text_clipped_from']).toBeUndefined();
    expect(envelope.payload['text']).toBe('short');
  });

  it('changes the envelope id, because the envelope content changed', () => {
    // Envelope ids are content hashes and evidence_refs point at them (§3.1). A clip is a
    // different observation, and must not masquerade as the unclipped one.
    const long = utterance('c'.repeat(9000));
    const clipped = toEnvelope(long, 'b'.repeat(64), '2026-07-01T10:00:01Z', 1000);
    const whole = toEnvelope(long, 'b'.repeat(64), '2026-07-01T10:00:01Z', 0);
    expect(clipped.id).not.toBe(whole.id);
  });

  it('stays deterministic — same input and clip, same id', () => {
    const u = utterance('d'.repeat(5000));
    expect(toEnvelope(u, 'b'.repeat(64), '2026-07-01T10:00:01Z', 1000).id).toBe(
      toEnvelope(u, 'b'.repeat(64), '2026-07-01T10:00:01Z', 1000).id,
    );
  });
});
