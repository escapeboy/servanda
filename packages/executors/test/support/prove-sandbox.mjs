#!/usr/bin/env node
/**
 * GATE GD, requirement 1: "an executor demonstrably cannot reach the network or CI secrets in
 * the sandbox test." Demonstrably — so this proves it rather than asserting it, in four parts.
 *
 *  A. THE TRAP IS ARMED. A canary spawned through the real `sandboxSpawnArgs()` tries fetch,
 *     dns.lookup, net.connect, https.request and child_process.spawnSync. Each must die with
 *     NETWORK_ACCESS_DENIED. If containment were removed, these would succeed and this section
 *     would fail — which is what makes the rest of the file evidence.
 *
 *  B. THE DENIAL IS THE TRAP'S, NOT THE NETWORK'S. The same fetch without the preload must fail
 *     *differently* (a connection error). Without this control, "the executor could not reach
 *     the network" and "there was no network to reach" look identical.
 *
 *  C. THE SECRETS ARE NOT IN ITS WORLD. Realistic CI secrets are planted in this process's
 *     environment. The canary reports every key and value it can see from inside the sandbox:
 *     none of the names, and none of the values, may appear. Then a real executor runs against
 *     the fixture and the produced artifact is searched for the same values.
 *
 *  D. STATIC. The transitive import closure of the sandbox host is walked. No module an
 *     executor can reach may import a network primitive, `child_process`, or the filesystem.
 *     This closes what a runtime trap cannot: a bypass through a lower-level binding.
 *
 * Exits non-zero, loudly, on any failure. Run directly: node prove-sandbox.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runExecutor, sandboxSpawnArgs, SANDBOX_HOST_ENTRY } from '@servanda/executors';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..', '..');
const REPO_ROOT = join(PKG, '..', '..');
const FIXTURE = join(REPO_ROOT, 'fixtures', 'archaeology-repo', 'repo');
const CANARY = join(HERE, 'canary.mjs');
const DENIED = 'NETWORK_ACCESS_DENIED';

/** Realistic, and fake. Planted in this process only, so the canary has something to find. */
const PLANTED_SECRETS = {
  GITHUB_TOKEN: 'ghp_gd0000000000000000000000000000000000',
  NPM_TOKEN: 'npm_gd000000000000000000000000000000000000',
  AWS_SECRET_ACCESS_KEY: 'gdAWSsecret0000000000000000000000000000',
  CI_JOB_TOKEN: 'gd-ci-job-token-0000000000',
};
for (const [k, v] of Object.entries(PLANTED_SECRETS)) process.env[k] = v;

let failures = 0;
const log = (s) => process.stdout.write(`${s}\n`);
function check(ok, label, detail = '') {
  log(`    ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
}

if (!existsSync(SANDBOX_HOST_ENTRY)) {
  log(`GD/sandbox: FAIL — ${SANDBOX_HOST_ENTRY} does not exist. Build: npx tsc -b packages/executors`);
  process.exit(1);
}
if (!existsSync(FIXTURE)) {
  log(`GD/sandbox: FAIL — fixture missing. Run: bash fixtures/archaeology-repo/setup.sh`);
  process.exit(1);
}

/** Spawn the canary through the REAL sandbox parameters. */
function runCanary(probe) {
  const { command, args, options } = sandboxSpawnArgs(CANARY);
  return spawnSync(command, [...args, probe], { ...options, encoding: 'utf8' });
}

// ── A. the trap is armed ──────────────────────────────────────────────────────────────────
log('==> GD/sandbox A: the trap is armed (positive controls)');
for (const probe of ['fetch', 'dns', 'net', 'https', 'spawn']) {
  const r = runCanary(probe);
  const out = `${r.stdout}${r.stderr}`;
  check(
    out.includes(DENIED) && !out.includes('"reached":true'),
    `${probe} is denied inside the sandbox`,
    out.split('\n').find((l) => l.includes(DENIED))?.slice(0, 90) ?? out.slice(0, 90),
  );
}

// ── B. the denial comes from the trap, not from an absent network ─────────────────────────
log('==> GD/sandbox B: the denial is the trap, not an absent network');
{
  const r = spawnSync(
    process.execPath,
    ['-e', "fetch('http://127.0.0.1:9/').then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})"],
    { encoding: 'utf8' },
  );
  const out = `${r.stdout}${r.stderr}`;
  check(!out.includes(DENIED), 'the same call without the preload fails differently', out.split('\n')[0]?.slice(0, 90));
}

// ── C. the secrets are not in the executor's world ────────────────────────────────────────
log('==> GD/sandbox C: CI secrets are absent from the executor world and from the artifact');
{
  const r = runCanary('env');
  const line = `${r.stdout}`.split('\n').find((l) => l.startsWith('CANARY '));
  check(line !== undefined, 'the canary reported its environment', `${r.stderr}`.slice(0, 120));
  if (line !== undefined) {
    const seen = JSON.parse(line.slice('CANARY '.length));
    // `__CF_USER_TEXT_ENCODING` is injected by macOS into any Node process after exec — it is
    // not inherited (a bare `/usr/bin/env` under the same spawn does not see it) and carries a
    // uid and a text encoding. Allow-listed by name, with that reason, rather than ignored.
    const PLATFORM_INJECTED = new Set(['SERVANDA_SANDBOX', '__CF_USER_TEXT_ENCODING']);
    check(
      seen.keys.every((k) => PLATFORM_INJECTED.has(k)),
      'the executor sees no environment variable but its marker',
      seen.keys.join(','),
    );
    // The general statement, not just about the four planted names: nothing the host holds
    // crossed into the executor.
    const leaked = seen.keys.filter((k) => !PLATFORM_INJECTED.has(k) && k in process.env);
    check(leaked.length === 0, 'no variable of the host process reached the executor', leaked.join(','));
    for (const [name, value] of Object.entries(PLANTED_SECRETS)) {
      check(!seen.keys.includes(name), `${name} is not a key in the executor's world`);
      check(!seen.values.includes(value), `the value of ${name} is nowhere in the executor's world`);
    }
    // Control: the secrets really are set out here, so their absence in there means something.
    check(
      Object.entries(PLANTED_SECRETS).every(([k, v]) => process.env[k] === v),
      'control: the secrets are set in the parent process',
    );
    // Negative control, the counterpart of section B: the same canary spawned WITHOUT the env
    // replacement does see them. So what removes the secrets is the sandbox, not their absence.
    const { command, args } = sandboxSpawnArgs(CANARY);
    const leaky = spawnSync(command, [...args, 'env'], { encoding: 'utf8' }); // inherits env
    const leakyLine = `${leaky.stdout}`.split('\n').find((l) => l.startsWith('CANARY '));
    const leakySeen = leakyLine === undefined ? { keys: [], values: [] } : JSON.parse(leakyLine.slice(7));
    check(
      leakySeen.values.includes(PLANTED_SECRETS.GITHUB_TOKEN),
      'control: without the env replacement the same canary DOES see GITHUB_TOKEN',
      `${leakySeen.keys.length} keys visible`,
    );
  }
}

let artifactJson = '';
{
  const outcome = await runExecutor({
    executorClass: 'dead-code',
    commitment: {
      v: 'servanda/0.1',
      type: 'commitment',
      owner: 'a'.repeat(64),
      owed_to: null,
      due: null,
      conditions: [],
      created_at: '2026-01-01T00:00:00Z',
      source: 'archaeology',
      confidence: 0.9,
      commitment_hash: 'b'.repeat(64),
    },
    target: { kind: 'symbol', symbol: 'FEATURE_LEGACY_IMPORT', path: 'src/flags.ts' },
    persona: 'a'.repeat(64),
    repo: { path: FIXTURE },
    now: '2026-07-26T10:00:00Z',
  });
  check(outcome.kind === 'artifact', 'a real executor produced an artifact under the sandbox', outcome.kind);
  if (outcome.kind === 'artifact') {
    artifactJson = JSON.stringify(outcome.artifact);
    check(outcome.artifact.draft === true, 'the artifact is a draft');
    check(outcome.artifact.signed_by === null, 'the artifact is unsigned (M-13)');
    for (const [name, value] of Object.entries(PLANTED_SECRETS)) {
      check(!artifactJson.includes(value), `the artifact does not contain the value of ${name}`);
      check(!artifactJson.includes(name), `the artifact does not mention ${name}`);
    }
  }
}

// ── D. static import-closure audit of everything an executor can reach ────────────────────
log('==> GD/sandbox D: static audit of the sandbox host import closure');
{
  const FORBIDDEN_BARE = /^node:(net|tls|dns|http|https|http2|dgram|child_process|fs|fs\/promises|worker_threads|vm|inspector)$/;
  const FORBIDDEN_TEXT = [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /process\.binding\s*\(/];
  const ALLOWED_BARE = new Set(['zod', '@servanda/types', '@servanda/crypto']);

  const seen = new Set();
  const bare = new Set();
  const hits = [];

  const walk = (file) => {
    const path = resolve(file);
    if (seen.has(path) || !existsSync(path)) return;
    seen.add(path);
    const text = readFileSync(path, 'utf8');
    for (const re of FORBIDDEN_TEXT) {
      if (re.test(text)) hits.push(`${path.replace(REPO_ROOT, '.')}: ${re}`);
    }
    // Real import forms only. Two things must not be mistaken for imports: a string an
    // executor *emits* (the `tests` class writes `import ... from 'vitest'` into the file it
    // proposes) and an ordinary `export const X = '...'`. The `from` keyword, or a bare
    // `import '...'`, is what distinguishes a module edge from a string literal.
    const specifiers = [
      ...text.matchAll(/^\s*import\s+[^;'"\n]*?\bfrom\s*['"]([^'"\n]+)['"]/gm),
      ...text.matchAll(/^\s*import\s*['"]([^'"\n]+)['"]/gm),
      ...text.matchAll(/^\s*export\s+[^;'"\n]*?\bfrom\s*['"]([^'"\n]+)['"]/gm),
      ...text.matchAll(/\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g),
    ];
    for (const m of specifiers) {
      const spec = m[1];
      if (spec.startsWith('.')) {
        walk(join(dirname(path), spec));
        continue;
      }
      bare.add(spec);
      if (FORBIDDEN_BARE.test(spec)) hits.push(`${path.replace(REPO_ROOT, '.')}: imports ${spec}`);
    }
  };

  walk(SANDBOX_HOST_ENTRY);
  check(seen.size > 3, 'walked the host closure', `${seen.size} modules`);
  check(hits.length === 0, 'no module an executor can reach imports network, subprocess or fs', hits.join(' | '));
  const unexpected = [...bare].filter((b) => !ALLOWED_BARE.has(b));
  check(
    unexpected.length === 0,
    'the closure reaches only allow-listed third-party packages',
    unexpected.join(','),
  );
  // Honest scope: third-party packages are checked by name, not by contents.
  log(`    note: bare imports in the closure = ${[...bare].sort().join(', ') || '(none)'} (checked by name)`);
}

log('');
if (failures > 0) {
  log(`GD/sandbox: FAIL (${failures} check(s) failed)`);
  process.exit(1);
}
log('GD/sandbox: PASS — trap armed, secrets absent from world and artifact, host closure clean');
