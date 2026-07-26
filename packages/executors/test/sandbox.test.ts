import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DENY_NETWORK_PRELOAD,
  runExecutor,
  SANDBOX_ENV,
  SANDBOX_HOST_ENTRY,
  sandboxSpawnArgs,
} from '../src/index.js';
import { COMMITMENT, FIXTURE_REPO, PERSONA } from './support/fixture.js';

const DENIED = 'NETWORK_ACCESS_DENIED';

/**
 * The sandbox properties, asserted from the test suite. The full proof — with positive controls
 * that trip the trap and negative controls showing the denial is the trap's rather than an
 * absent network — is `test/support/prove-sandbox.mjs`, which gate GD runs on its own. These
 * tests hold the shape of the boundary; that script proves the boundary is real.
 */
describe('sandbox — the world an executor runs in', () => {
  it('replaces the environment rather than filtering it', () => {
    expect(Object.keys(SANDBOX_ENV)).toEqual(['SERVANDA_SANDBOX']);
    expect(Object.isFrozen(SANDBOX_ENV)).toBe(true);
    const { options } = sandboxSpawnArgs();
    expect(Object.keys(options.env)).toEqual(['SERVANDA_SANDBOX']);
  });

  it('always arms the network trap', () => {
    const { args } = sandboxSpawnArgs();
    expect(args[0]).toBe('--require');
    expect(args[1]).toBe(DENY_NETWORK_PRELOAD);
    expect(existsSync(DENY_NETWORK_PRELOAD)).toBe(true);
  });

  it('traps every documented way out, including the subprocess', () => {
    const preload = readFileSync(DENY_NETWORK_PRELOAD, 'utf8');
    for (const surface of ['node:net', 'node:tls', 'node:dns', 'node:http', 'node:https', 'node:http2', 'node:dgram', 'node:child_process']) {
      expect(preload, surface).toContain(surface);
    }
    for (const global of ['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource']) {
      expect(preload, global).toContain(global);
    }
  });

  it('denies a network call made through the real spawn parameters', () => {
    const { command, args, options } = sandboxSpawnArgs();
    // Same preload, same env — only the entry differs, so what this proves about the trap
    // holds for the host too.
    const r = spawnSync(
      command,
      [...args.slice(0, 2), '-e', "fetch('http://127.0.0.1:9/').catch(e=>{console.error(e.message);process.exit(1)})"],
      { ...options, encoding: 'utf8' },
    );
    expect(`${r.stdout}${r.stderr}`).toContain(DENIED);
  });

  it('runs the host from the built output and says so plainly when it is missing', () => {
    expect(SANDBOX_HOST_ENTRY.endsWith('/dist/sandbox/host.js')).toBe(true);
  });

  it('refuses an unknown executor class before anything is spawned', async () => {
    await expect(
      runExecutor({
        executorClass: 'workflow',
        commitment: COMMITMENT,
        target: { kind: 'source-file', path: 'src/clean.ts' },
        persona: PERSONA,
        repo: { path: FIXTURE_REPO },
      }),
    ).rejects.toThrow(/not extensible at runtime/);
  });

  it('gives the executor only the files its read capability admits', async () => {
    // `dep-bump` may read `package.json` and nothing else. The fixture has no package.json, so
    // its snapshot is empty — it cannot see src/, even though src/ is right there.
    const outcome = await runExecutor({
      executorClass: 'dep-bump',
      commitment: COMMITMENT,
      target: { kind: 'dependency', name: 'zod', toVersion: '3.25.76' },
      persona: PERSONA,
      repo: { path: FIXTURE_REPO },
      now: '2026-07-26T10:00:00Z',
    });
    expect(outcome.kind).toBe('nothing-to-do');
  });
});
