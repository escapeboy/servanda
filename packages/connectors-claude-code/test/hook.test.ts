import { describe, expect, it } from 'vitest';
import { Envelope } from '@servanda/types';
import { ClaudeCodeConnector } from '../src/index.js';

const PERSONA = '8'.repeat(64);
const connector = new ClaudeCodeConnector({ persona: PERSONA });
const ctx = { occurredAt: '2026-01-03T10:00:00Z', receivedAt: '2026-01-03T10:00:00Z' };

const BASE = {
  session_id: 'sess-9',
  transcript_path: '/Users/dana/.claude/projects/-Users-dana-api/sess-9.jsonl',
  cwd: '/Users/dana/htdocs/api',
  permission_mode: 'default',
};

describe('Claude Code session hook events become §2 envelopes', () => {
  it('maps UserPromptSubmit to session_utterance', () => {
    const [envelope] = connector.fromHookEvent(
      { ...BASE, hook_event_name: 'UserPromptSubmit', prompt: 'ship the retry fix today' },
      ctx,
    );
    expect(Envelope.parse(envelope)).toBeTruthy();
    expect(envelope.source).toBe('transcript');
    expect(envelope.kind).toBe('session_utterance');
    expect(envelope.payload['text']).toBe('ship the retry fix today');
    expect(envelope.payload['role']).toBe('user');
    expect(envelope.refs).toEqual([{ kind: 'file', value: BASE.transcript_path }]);
  });

  it('maps session lifecycle events', () => {
    const start = connector.fromHookEvent({ ...BASE, hook_event_name: 'SessionStart', source: 'startup' }, ctx);
    const end = connector.fromHookEvent({ ...BASE, hook_event_name: 'SessionEnd', reason: 'clear' }, ctx);
    const stop = connector.fromHookEvent({ ...BASE, hook_event_name: 'Stop' }, ctx);
    expect(start[0]?.kind).toBe('session_start');
    expect(start[0]?.payload['session_source']).toBe('startup');
    expect(end[0]?.kind).toBe('session_end');
    expect(end[0]?.payload['end_reason']).toBe('clear');
    expect(stop[0]?.kind).toBe('session_turn_end');
  });

  it('emits nothing for unmodelled or unusable events', () => {
    expect(connector.fromHookEvent({ ...BASE, hook_event_name: 'PostToolUse', tool_name: 'Bash' }, ctx)).toEqual([]);
    expect(connector.fromHookEvent({ ...BASE, hook_event_name: 'PreToolUse' }, ctx)).toEqual([]);
    expect(connector.fromHookEvent({ ...BASE, hook_event_name: 'UserPromptSubmit' }, ctx)).toEqual([]);
    expect(connector.fromHookEvent({ hook_event_name: 'SessionStart' }, { ...ctx, occurredAt: 'now' })).toEqual([]);
    expect(connector.fromHookEvent(null, ctx)).toEqual([]);
    expect(connector.fromHookEvent('SessionStart', ctx)).toEqual([]);
    expect(connector.fromHookEvent([], ctx)).toEqual([]);
  });

  it('cannot be steered by a hook_event_name the connector does not know', () => {
    expect(
      connector.fromHookEvent({ ...BASE, hook_event_name: 'archaeology_todo', prompt: 'x' }, ctx),
    ).toEqual([]);
  });

  it('is deterministic given the same event and the same injected instants', () => {
    const event = { ...BASE, hook_event_name: 'UserPromptSubmit', prompt: 'hello' };
    expect(JSON.stringify(connector.fromHookEvent(event, ctx))).toBe(
      JSON.stringify(connector.fromHookEvent(event, ctx)),
    );
  });
});
