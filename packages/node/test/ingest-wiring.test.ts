import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStubModelClient, ingestEnvelopeLog } from '@servanda/extraction';
import { LocalPendingSink } from '../src/ingest.js';
import { makeFixture, type Fixture } from './support/fixture.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, '..', '..', 'connectors-claude-code', 'bin', 'servanda-cc-hook.mjs');
const DIST = join(HERE, '..', 'dist');

/**
 * §3's headline surface, end to end, through the real processes.
 *
 * Until this existed the chain had two finished halves and no join: the shipped hook wrote
 * `$SERVANDA_ENVELOPE_LOG` and **nothing in the repository read it**, while the extraction
 * harness read Claude Code's transcripts directly. `docs/USAGE.md` admitted as much.
 *
 * The hook is spawned rather than imitated, because the point of the path is that the file one
 * module writes is the file another module reads, and a fixture in the middle would be the two
 * halves agreeing with a third thing instead of with each other.
 */
describe('a person registers the hook, and sees promises', () => {
  let fx: Fixture;
  let log: string;

  const PROMPTS = [
    'I will send Maria the quote by Friday, whatever else happens this week.',
    'I am going to rewrite the retry logic before the release goes out.',
  ];

  beforeAll(async () => {
    fx = makeFixture();
    log = join(mkdtempSync(join(tmpdir(), 'servanda-wiring-')), 'envelopes.ndjson');

    for (const prompt of PROMPTS) {
      const run = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({
          hook_event_name: 'UserPromptSubmit',
          prompt,
          session_id: 'sess-wiring',
          cwd: '/Users/dana/htdocs/api',
        }),
        env: { ...process.env, SERVANDA_PERSONA: fx.personas[0]!, SERVANDA_ENVELOPE_LOG: log },
        timeout: 20_000,
      });
      expect(run.status, (run.stderr ?? Buffer.alloc(0)).toString()).toBe(0);
    }

    const result = await ingestEnvelopeLog({
      logPath: log,
      persona: fx.personas[0]!,
      model: createStubModelClient(),
      sink: new LocalPendingSink(fx.node),
      now: () => fx.now.toISOString(),
    });
    expect(result.logMissing).toBe(false);
    expect(result.queued).toBeGreaterThan(0);
    if (result.cursor) fx.node.local.writeCursor(fx.personas[0]!, result.cursor);
  }, 120_000);

  afterAll(() => fx.cleanup());

  it('and they arrive where §7 says a person looks for a decision', () => {
    const view = fx.node.openLoops({ view: 'pending', persona: null, limit: 50, cursor: null });
    expect(view.total).toBeGreaterThan(0);
    // The register carries what the person said, and the acts they may take on it — both of them.
    // A queue you can only say yes to is not a queue.
    const acts = view.items.flatMap((i) => i.actions.map((a) => a.act)).sort();
    expect(new Set(acts)).toEqual(new Set(['confirm', 'dismiss']));
    expect(view.items.some((i) => i.intent_or_expect.includes('Maria'))).toBe(true);
  });

  it('and a second run queues nothing, having already seen those envelopes', async () => {
    const before = fx.node.openLoops({ view: 'pending', persona: null, limit: 50, cursor: null }).total;
    const again = await ingestEnvelopeLog({
      logPath: log,
      persona: fx.personas[0]!,
      model: createStubModelClient(),
      sink: new LocalPendingSink(fx.node),
      // The cursor is deliberately NOT passed: this is the restart-after-a-crash case, where the
      // cheap defence is gone and only the durable marker is left. If `hasIngestedEnvelope` were
      // answered from the queue's contents this would double the register.
      now: () => fx.now.toISOString(),
    });
    expect(again.alreadyIngested).toBeGreaterThan(0);
    expect(again.queued).toBe(0);
    expect(fx.node.openLoops({ view: 'pending', persona: null, limit: 50, cursor: null }).total).toBe(before);
  }, 120_000);

  it('and confirming one moves it out of the queue and into the vault', () => {
    const item = fx.node.openLoops({ view: 'pending', persona: null, limit: 50, cursor: null }).items[0]!;
    const out = fx.node.confirm({ id: item.id, decision: 'confirm' });
    expect(out.state).toBe('confirmed');
    expect(fx.node.local.getPending(fx.personas[0]!, item.id)).toBeNull();
  });

  it('and a confirmed envelope is still an ingested envelope, so it never comes back', async () => {
    const after = await ingestEnvelopeLog({
      logPath: log,
      persona: fx.personas[0]!,
      model: createStubModelClient(),
      sink: new LocalPendingSink(fx.node),
      now: () => fx.now.toISOString(),
    });
    expect(after.queued).toBe(0);
  }, 120_000);
});

/**
 * M-10, guarded where a comment alone would not hold it.
 *
 * `src/ingest.ts` imports `@servanda/extraction` with `import type`, which is erased. It has to
 * be: that package depends on `@anthropic-ai/sdk`, so a value import would put an HTTP client
 * inside a node whose whole claim is that it works with no network. Someone deleting the word
 * `type` would break M-10 and nothing here would have noticed — the emitted file simply gains an
 * import, every test still passes, and the property is gone.
 */
describe('M-10: nothing of the model client reaches the shipped node', () => {
  it('no emitted file imports @servanda/extraction or an SDK', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith('.js')) continue;
        const source = readFileSync(path, 'utf8');
        // Import statements only. The prose in `ingest.ts` names both packages on purpose, and a
        // check that matched prose would fail on the comment explaining why it must not fail.
        for (const match of source.matchAll(/^\s*(?:import|export)[^\n]*?from\s+['"]([^'"]+)['"]/gm)) {
          const spec = match[1]!;
          if (spec.includes('@servanda/extraction') || spec.includes('anthropic')) {
            offenders.push(`${path}: ${spec}`);
          }
        }
        for (const match of source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
          const spec = match[1]!;
          if (spec.includes('@servanda/extraction') || spec.includes('anthropic')) {
            offenders.push(`${path}: require(${spec})`);
          }
        }
      }
    };
    walk(DIST);
    expect(offenders).toEqual([]);
  });
});
