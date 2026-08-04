import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStubModelClient } from '@servanda/extraction';
import { makeFixture, type Fixture } from '../../node/test/support/fixture.js';
import { runIngest } from '../src/run.js';
import { logPathFrom } from '../src/bin/servanda-ingest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, '..', '..', 'connectors-claude-code', 'bin', 'servanda-cc-hook.mjs');

/**
 * The loop nobody was running.
 *
 * `ingestEnvelopeLog` reads ONE budget's worth and hands back a cursor. Everything downstream of
 * §3 was built and tested — the reader, the port, the sink, the queue, the view — and a person
 * who registered the hook still saw nothing, because no code called it twice and saved where it
 * got to. That gap is the whole reason this package exists.
 */
describe('the whole log reaches the queue, across runs', () => {
  let fx: Fixture;
  let logPath: string;

  const PROMPTS = [
    'I will send Maria the quote by Friday, whatever else happens this week.',
    'I am going to rewrite the retry logic before the release goes out.',
    'I promise to review the migration guide for Ivan tomorrow morning.',
  ];

  beforeAll(() => {
    fx = makeFixture();
    logPath = join(mkdtempSync(join(tmpdir(), 'servanda-driver-')), 'envelopes.ndjson');
    for (const prompt of PROMPTS) {
      const run = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          prompt,
          session_id: 'sess-driver',
          cwd: '/Users/dana/htdocs/api',
        }),
        env: { ...process.env, SERVANDA_PERSONA: fx.personas[0]!, SERVANDA_ENVELOPE_LOG: logPath },
        timeout: 20_000,
      });
      expect(run.status, (run.stderr ?? Buffer.alloc(0)).toString()).toBe(0);
    }
  }, 120_000);

  afterAll(() => fx.cleanup());

  it('reads the log and queues what it found', async () => {
    const report = await runIngest({
      node: fx.node,
      local: fx.node.local,
      persona: fx.personas[0]!,
      logPath,
      model: createStubModelClient(),
      now: () => fx.now.toISOString(),
    });
    expect(report.logMissing).toBe(false);
    expect(report.envelopesIngested).toBeGreaterThanOrEqual(PROMPTS.length);
    expect(report.queued).toBeGreaterThan(0);
    expect(report.incomplete).toBe(false);
  }, 120_000);

  it('and SAVES how far it got, so the next run reads nothing', async () => {
    // The cursor is the whole reason a driver is more than a for-loop: it is written by this
    // package and read back by it, and if it were not persisted every run would start from byte
    // zero. `hasIngested` would still stop the duplicates, so the failure would be invisible —
    // it would only cost a model call per envelope per run, for ever.
    const saved = fx.node.local.readCursor(fx.personas[0]!);
    expect(saved).not.toBeNull();
    expect(saved!.offset).toBeGreaterThan(0);

    const again = await runIngest({
      node: fx.node,
      local: fx.node.local,
      persona: fx.personas[0]!,
      logPath,
      model: createStubModelClient(),
      now: () => fx.now.toISOString(),
    });
    expect(again.queued).toBe(0);
    expect(again.envelopesIngested).toBe(0);
  }, 120_000);

  it('and what it queued is what a person sees', () => {
    const view = fx.node.openLoops({ view: 'pending', persona: null, limit: 50, cursor: null });
    expect(view.total).toBeGreaterThan(0);
    expect(view.items.some((i) => i.intent_or_expect.includes('Maria'))).toBe(true);
  });
});

describe('a log that is not there is not a failure', () => {
  it('says so and stops, because a fresh install has no log until the hook fires', async () => {
    const fx = makeFixture();
    const report = await runIngest({
      node: fx.node,
      local: fx.node.local,
      persona: fx.personas[0]!,
      logPath: join(tmpdir(), 'servanda-no-such-log-9f3a2b.ndjson'),
      model: createStubModelClient(),
      now: () => fx.now.toISOString(),
    });
    expect(report.logMissing).toBe(true);
    // NOT incomplete: nothing was left unfinished, there was nothing to finish. Reporting this
    // as a shortfall would teach somebody to ignore the shortfall.
    expect(report.incomplete).toBe(false);
    expect(report.queued).toBe(0);
    fx.cleanup();
  }, 120_000);
});

describe('where the log is read from', () => {
  it('prefers the variable the hook is configured with', () => {
    expect(logPathFrom({ SERVANDA_ENVELOPE_LOG: '/tmp/somewhere.ndjson' })).toBe('/tmp/somewhere.ndjson');
  });

  it('and falls back to the path the documentation gives, not to nothing', () => {
    // If this default and the hook's documented one ever disagree, a person registers the hook,
    // runs the command, and is told there is nothing to read while the file sits full nearby.
    expect(logPathFrom({})).toMatch(/\.servanda-envelopes\.ndjson$/u);
  });

  it('treats an empty variable as unset rather than as a path', () => {
    expect(logPathFrom({ SERVANDA_ENVELOPE_LOG: '' })).toMatch(/\.servanda-envelopes\.ndjson$/u);
  });
});
