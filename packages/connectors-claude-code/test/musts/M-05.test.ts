import { describe, expect, it } from 'vitest';
import { ClaudeCodeConnector } from '../../src/index.js';

const WORK = '9'.repeat(64);
const CLIENT = 'a'.repeat(64);
const ctx = { receivedAt: '2026-07-07T00:00:00Z' };

const LINE = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: 'I owe the client a status note.' },
  uuid: '44444444-4444-4444-8444-444444444444',
  timestamp: '2026-01-04T09:00:00Z',
  sessionId: 'sess-2',
});

/**
 * M-5 — "No org-context mixing in any pipeline."
 *
 * A transcript is the sharpest case: one machine, one `~/.claude`, several clients' work in
 * adjacent session files. The binding is at construction, so separating them is not a
 * discipline the caller has to remember at each call — it is the only thing the API allows.
 */
describe('M-5: a connector instance is bound to exactly one persona at registration', () => {
  it('takes the persona at construction and exposes it', () => {
    expect(new ClaudeCodeConnector({ persona: WORK }).persona).toBe(WORK);
  });

  it('rejects anything that is not a persona id, at construction', () => {
    for (const bad of ['', 'not-hex', 'B'.repeat(64), 'b'.repeat(63)]) {
      expect(() => new ClaudeCodeConnector({ persona: bad })).toThrow();
    }
  });

  it('stamps every transcript envelope with the bound persona', () => {
    for (const envelope of new ClaudeCodeConnector({ persona: WORK }).fromTranscript(LINE, ctx)) {
      expect(envelope.persona).toBe(WORK);
    }
  });

  it('stamps every hook envelope with the bound persona, ignoring any persona in the event', () => {
    const [envelope] = new ClaudeCodeConnector({ persona: CLIENT }).fromHookEvent(
      { hook_event_name: 'UserPromptSubmit', prompt: 'hi', persona: WORK, session_id: 's' },
      { occurredAt: '2026-01-04T09:00:00Z', receivedAt: ctx.receivedAt },
    );
    expect(envelope.persona).toBe(CLIENT);
  });

  it('gives two personas disjoint envelope sets over the identical transcript', () => {
    const work = new ClaudeCodeConnector({ persona: WORK }).fromTranscript(LINE, ctx);
    const client = new ClaudeCodeConnector({ persona: CLIENT }).fromTranscript(LINE, ctx);
    expect(work).toHaveLength(1);
    expect(client).toHaveLength(1);
    expect(work[0].id).not.toBe(client[0].id);
    expect(work[0].payload).toEqual(client[0].payload);
  });

  it('offers no API that accepts a persona per call', () => {
    const connector = new ClaudeCodeConnector({ persona: WORK });
    expect(connector.fromTranscript.length).toBe(2);
    expect(connector.fromTranscriptFile.length).toBe(2);
    expect(connector.fromTranscriptDir.length).toBe(2);
    expect(connector.fromHookEvent.length).toBe(2);
  });
});
