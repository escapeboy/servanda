#!/usr/bin/env node
/**
 * GATE GF, requirement 1: "two nodes reach agreement over a transport with no network" —
 * PROVE it, don't assert it. Modelled on GA's prover, and held to the same standard.
 *
 * Three independent proofs, all of which must pass:
 *
 *  A. RUNTIME. Four positive controls confirm the trap is armed (a child that tries fetch /
 *     dns.lookup / net.connect / https.request under `--require deny-network.cjs` must die with
 *     NETWORK_ACCESS_DENIED), and one negative control confirms the denial comes from the trap
 *     rather than from an absent network (the same fetch WITHOUT the preload must fail with a
 *     connection error, not NETWORK_ACCESS_DENIED). Only then is the real two-node convergence
 *     run under the trap.
 *
 *  B. MEDIUM. The git transport spawns `git`, which the in-process trap cannot reach. So the
 *     scenario asserts its shared repository is a filesystem path with no scheme and no host,
 *     and this prover re-checks that the scenario never configures a URL remote.
 *
 *  C. STATIC. The shipped module graph (@servanda/federation and everything it ships on top of)
 *     is scanned for network imports and for any use of a GLOBAL fetch/XHR/WebSocket. The hub
 *     transport is allowed to speak HTTP — through an INJECTED client — so a global reach is
 *     the thing that must never appear.
 *
 * Exits non-zero, loudly, on any failure. Run directly: node prove-no-network.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..', '..');
const PRELOAD = join(HERE, 'deny-network.cjs');
const SCENARIO = join(HERE, 'two-nodes-offline.mjs');
const DENIED = 'NETWORK_ACCESS_DENIED';

let failures = 0;
const log = (s) => process.stdout.write(`${s}\n`);

function check(ok, label, detail = '') {
  log(`    ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
}

if (!existsSync(join(PKG, 'dist', 'index.js'))) {
  log(`GF/no-network: FAIL — ${join(PKG, 'dist', 'index.js')} does not exist. Build first.`);
  process.exit(1);
}

// ── A1. the trap is armed ─────────────────────────────────────────────────────────────────

function runSnippet(code, { preload }) {
  const args = preload ? ['--require', PRELOAD, '-e', code] : ['-e', code];
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

log('==> GF/no-network A1: the trap is armed (positive controls)');
for (const [label, code] of [
  ['fetch', "fetch('http://127.0.0.1:9/').then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})"],
  ['dns.lookup', "require('node:dns').lookup('example.com',()=>{})"],
  ['net.connect', "require('node:net').connect(9,'127.0.0.1')"],
  ['https.request', "require('node:https').request('https://example.com')"],
]) {
  const r = runSnippet(code, { preload: true });
  const out = `${r.stdout}${r.stderr}`;
  check(out.includes(DENIED), `${label} is denied under the preload`, out.split('\n')[0]?.slice(0, 90));
}

log('==> GF/no-network A2: the denial comes from the trap, not from an absent network');
{
  const r = runSnippet(
    "fetch('http://127.0.0.1:9/').then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})",
    { preload: false },
  );
  const out = `${r.stdout}${r.stderr}`;
  check(!out.includes(DENIED), 'the same call without the preload fails differently', out.split('\n')[0]?.slice(0, 90));
}

// ── A3. two nodes converge, under the trap ────────────────────────────────────────────────

log('==> GF/no-network A3: two nodes reach agreement over the git transport, networking denied');
{
  const r = spawnSync(process.execPath, ['--require', PRELOAD, SCENARIO], { encoding: 'utf8' });
  const stderr = r.stderr ?? '';
  check(!stderr.includes(DENIED), 'neither node touched a network primitive', stderr.slice(0, 200));

  let report = null;
  for (const line of (r.stdout ?? '').split('\n')) {
    if (line.trim().startsWith('{')) {
      try {
        report = JSON.parse(line);
      } catch {
        /* not the report line */
      }
    }
  }
  if (!check(report !== null, 'the scenario produced a report', (r.stdout ?? stderr).slice(0, 200))) {
    log(stderr.slice(0, 2000));
  } else {
    for (const f of report.failures ?? []) check(false, `scenario: ${f}`);
    check(report.ok === true, 'two nodes converged on one chain and one state', JSON.stringify(report.states));
  }
  check(r.status === 0, 'the scenario exited cleanly', `exit=${r.status}`);
}

// ── B. the medium is local ────────────────────────────────────────────────────────────────

log('==> GF/no-network B: the shared medium is a local repository, not a remote');
{
  const source = readFileSync(SCENARIO, 'utf8');
  check(!/https?:\/\//.test(source.replace(/^\s*\*.*$/gm, '')), 'the scenario configures no URL remote');
  check(/initShared\(/.test(source), 'the scenario creates its own bare repository');
}

// ── C. static import-graph audit ──────────────────────────────────────────────────────────

log('==> GF/no-network C: static import-graph audit of the shipped modules');

const FORBIDDEN = [
  [/from\s+['"]node:(net|tls|dns|http|https|http2|dgram)['"]/, 'imports a network module'],
  [/require\(\s*['"]node:(net|tls|dns|http|https|http2|dgram)['"]\s*\)/, 'requires a network module'],
  [/from\s+['"](undici|node-fetch|axios|got|ws)['"]/, 'imports an HTTP client'],
  // A global reach. `this.http(...)` and `opts.fetch` are fine: the client is injected, which
  // is the property under test — a node that configures no hub cannot be made to open a socket.
  [/(?<![.\w$])fetch\s*\(/, 'calls a global fetch'],
  [/(?<![.\w$])XMLHttpRequest\b/, 'uses XMLHttpRequest'],
  [/(?<![.\w$])WebSocket\b/, 'uses WebSocket'],
];

function jsFiles(root, out = []) {
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) jsFiles(p, out);
    else if (p.endsWith('.js') && statSync(p).isFile()) out.push(p);
  }
  return out;
}

const roots = ['federation', 'node', 'vault', 'crypto', 'types'].map((p) => join(PKG, '..', p, 'dist'));
let scanned = 0;
const hits = [];
for (const root of roots) {
  for (const file of jsFiles(root)) {
    scanned++;
    const text = readFileSync(file, 'utf8');
    for (const [re, why] of FORBIDDEN) {
      if (re.test(text)) hits.push(`${file.replace(`${PKG}/..`, 'packages')}: ${why}`);
    }
  }
}
check(scanned > 0, 'found built modules to scan', `${scanned} files`);
check(hits.length === 0, 'no shipped module reaches the network on its own', hits.join(' | '));

log('');
if (failures > 0) {
  log(`GF/no-network: FAIL (${failures} check(s) failed)`);
  process.exit(1);
}
log(`GF/no-network: PASS — trap armed, ${scanned} shipped modules scanned, two nodes converged offline`);
