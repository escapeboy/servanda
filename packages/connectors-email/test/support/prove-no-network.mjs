#!/usr/bin/env node
/**
 * GATE GK, requirement 4: "the package cannot reach out — arm a trap and prove the denial comes
 * from the trap." Modelled on packages/node/test/support/prove-no-network.mjs.
 *
 * Two independent proofs, both of which must pass:
 *
 *  A. RUNTIME. The full workload (fixture capture, sent-mail archaeology, the BCC/forward
 *     gesture, the whole hostile corpus) runs in a child process under
 *     `--require deny-network.cjs`, which replaces net/tls/dns/http/https/http2/dgram/fetch/
 *     WebSocket with throwers. Four positive controls confirm the trap is ARMED (a child that
 *     tries fetch / dns.lookup / net.connect / https.request must die with
 *     NETWORK_ACCESS_DENIED) and one negative control confirms the denial comes from the TRAP
 *     rather than from an absent network (the same fetch WITHOUT the preload must fail with a
 *     connection error, not NETWORK_ACCESS_DENIED). Only then is the real workload run, and its
 *     summary is checked so a silent no-op cannot pass as a clean run.
 *
 *  B. STATIC. The shipped module graph (@servanda/connectors-email and the two packages it
 *     depends on) is scanned for any import of a network module or use of fetch/XHR. Nothing
 *     may match. This closes the hole the runtime trap cannot: a bypass through a lower-level
 *     binding.
 *
 * The IMAP transport is an injected interface precisely so this can be true. A real client is
 * constructed by the CALLER and never enters this package's graph.
 *
 * Exits non-zero, loudly, on any failure. Run directly: node prove-no-network.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HERE = import.meta.dirname;
const PKG = resolve(HERE, '../..');
const PRELOAD = join(HERE, 'deny-network.cjs');
const WORKLOAD = join(HERE, 'run-offline.mjs');
const DENIED = 'NETWORK_ACCESS_DENIED';

let failures = 0;
const log = (s) => process.stdout.write(`${s}\n`);

function check(ok, label, detail = '') {
  log(`    ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
}

if (!existsSync(join(PKG, 'dist', 'index.js'))) {
  log(`GK/no-network: FAIL — ${PKG}/dist does not exist. Build first: npx tsc -b packages/connectors-email`);
  process.exit(1);
}

// ── A1/A2. controls ───────────────────────────────────────────────────────────────────────

function runSnippet(code, { preload }) {
  const args = preload ? ['--require', PRELOAD, '-e', code] : ['-e', code];
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

const FETCH = "fetch('http://127.0.0.1:9/').then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})";

log('==> GK/no-network A1: the trap is armed (positive controls)');
for (const [label, code] of [
  ['fetch', FETCH],
  ['dns.lookup', "require('node:dns').lookup('example.com',()=>{})"],
  ['net.connect', "require('node:net').connect(9,'127.0.0.1')"],
  ['https.request', "require('node:https').request('https://example.com')"],
]) {
  const r = runSnippet(code, { preload: true });
  const out = `${r.stdout}${r.stderr}`;
  check(out.includes(DENIED), `${label} is denied under the preload`, out.split('\n')[0]?.slice(0, 90));
}

log('==> GK/no-network A2: the denial comes from the trap, not from an absent network');
{
  const r = runSnippet(FETCH, { preload: false });
  const out = `${r.stdout}${r.stderr}`;
  check(!out.includes(DENIED), 'the same call without the preload fails differently', out.split('\n')[0]?.slice(0, 90));
}

// ── A3. the real workload, under the trap ─────────────────────────────────────────────────

log('==> GK/no-network A3: the whole connector workload runs with networking denied');
{
  const r = spawnSync(process.execPath, ['--require', PRELOAD, WORKLOAD], { encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  check(r.status === 0, 'the workload exited cleanly', `exit=${r.status} ${r.stderr.slice(0, 200)}`);
  check(!out.includes(DENIED), 'nothing in the package touched a network primitive', out.slice(0, 200));

  let summary;
  try {
    summary = JSON.parse(r.stdout);
  } catch {
    summary = undefined;
  }
  check(summary !== undefined, 'the workload reported a summary');
  if (summary !== undefined) {
    check(summary.capture === 9, 'fixture capture ran offline', `${summary.capture} envelopes`);
    check(summary.archaeology === 4, 'sent-mail archaeology ran offline', `${summary.archaeology} envelopes`);
    check(summary.gestures === 2, 'the BCC/forward gesture ran offline', `${summary.gestures} envelopes`);
    check(summary.hostileCases >= 20, 'the hostile corpus was exercised', `${summary.hostileCases} cases`);
    check(summary.hostile > 0, 'hostile input produced envelopes offline', `${summary.hostile} envelopes`);
  }
}

// ── B. static import-graph audit ──────────────────────────────────────────────────────────

log('==> GK/no-network B: static import-graph audit of the shipped modules');

const FORBIDDEN = [
  /from\s+['"]node:(net|tls|dns|http|https|http2|dgram)['"]/,
  /require\(\s*['"]node:(net|tls|dns|http|https|http2|dgram)['"]\s*\)/,
  /from\s+['"](undici|node-fetch|axios|got|ws|imapflow|node-imap|mailparser)['"]/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
];

function jsFiles(root, out = []) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) jsFiles(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

const roots = ['connectors-email', 'crypto', 'types'].map((p) => join(PKG, '..', p, 'dist'));
let scanned = 0;
const hits = [];
for (const root of roots) {
  for (const file of jsFiles(root)) {
    scanned++;
    const text = readFileSync(file, 'utf8');
    for (const re of FORBIDDEN) {
      if (re.test(text)) hits.push(`${file.replace(`${PKG}/..`, 'packages')}: ${re}`);
    }
  }
}
check(scanned > 0, 'found built modules to scan', `${scanned} files`);
check(hits.length === 0, 'no shipped module imports a network primitive', hits.join(' | '));

log('');
if (failures > 0) {
  log(`GK/no-network: FAIL (${failures} check(s) failed)`);
  process.exit(1);
}
log(`GK/no-network: PASS — trap armed, ${scanned} shipped modules scanned, full workload ran offline`);
