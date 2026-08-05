import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Envelope } from '@servanda/types';
import { ClaudeCodeConnector } from '../src/index.js';

const PERSONA = '8'.repeat(64);
const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'servanda-cc-hook.mjs');
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

describe('a session Servanda spawned is not captured', () => {
  /**
   * The loop this closes, observed within a minute of the hook being switched on for the first
   * time, on a log holding exactly one real utterance.
   *
   * `servanda-ingest` with the CLI backend spawns `claude`. A spawned session fires the user's own
   * UserPromptSubmit hooks, so this connector wrote the EXTRACTION PROMPT into the envelope log —
   * a prompt whose body quotes the utterances it was just handed. The next run then reads that
   * back and pays a model to look for promises inside a JSON array of previous promises.
   *
   * A capture surface that captures its own reader grows on every turn and costs money doing it.
   */
  it('writes nothing at all when SERVANDA_CAPTURE is off', () => {
    const log = join(mkdtempSync(join(tmpdir(), 'servanda-loop-')), 'envelopes.ndjson');
    const run = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'the extraction prompt, which must never come back in',
        session_id: 'spawned',
        cwd: '/tmp',
      }),
      env: {
        ...process.env,
        SERVANDA_CAPTURE: 'off',
        SERVANDA_PERSONA: PERSONA,
        SERVANDA_ENVELOPE_LOG: log,
      },
      timeout: 20_000,
    });
    expect(run.status).toBe(0);
    // Not "wrote an empty file" — did not create one. The check is before stdin is read.
    expect(existsSync(log)).toBe(false);
  });

  it('and captures normally when it is not set, so the guard is narrow', () => {
    // A guard that also silenced ordinary use would be worse than the loop.
    const log = join(mkdtempSync(join(tmpdir(), 'servanda-loop-')), 'envelopes.ndjson');
    const run = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'something a person actually typed',
        session_id: 'human',
        cwd: '/tmp',
      }),
      env: { ...process.env, SERVANDA_PERSONA: PERSONA, SERVANDA_ENVELOPE_LOG: log },
      timeout: 20_000,
    });
    expect(run.status).toBe(0);
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});
