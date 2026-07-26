#!/usr/bin/env node
/**
 * GATE GG, requirement 3: "prove the package cannot reach out — arm a trap and show the denial
 * comes from the trap rather than an absent network."
 *
 * Three proofs, all of which must pass:
 *
 *  A. RUNTIME. A child process runs under `--require deny-network.cjs`, which replaces
 *     net/tls/dns(+resolveTxt)/http/https/http2/dgram/fetch/WebSocket with throwers. Four
 *     positive controls confirm the trap is armed, and a negative control confirms the denial
 *     comes FROM THE TRAP rather than from a machine with no network: the same fetch without
 *     the preload must fail with a connection error, not NETWORK_ACCESS_DENIED.
 *
 *  B. THE REAL WORK, UNDER THE TRAP. In that same trapped child, @servanda/identity is driven
 *     through everything §1 asks of it — attestation, revocation boundary, anchor resolution
 *     from an injected transport, the full ladder, rotation, linking, recovery. It must reach
 *     level 3 (which requires an anchor) without a single network primitive firing. A control
 *     inside the child proves the trap would have caught it: a transport that calls the real
 *     fetch dies with NETWORK_ACCESS_DENIED, and the resolver surfaces it as `unreachable`.
 *
 *  C. STATIC. The shipped module graph (@servanda/identity + its deps) is scanned for any
 *     import of a network module or use of fetch/XHR. Nothing may match — this closes the hole
 *     the runtime trap cannot, a bypass through a lower-level binding.
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
const EXERCISE = join(HERE, 'exercise-identity.mjs');
const DIST = join(PKG, 'dist', 'index.js');
const DENIED = 'NETWORK_ACCESS_DENIED';

let failures = 0;
const log = (s) => process.stdout.write(`${s}\n`);

function check(ok, label, detail = '') {
  log(`    ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
}

if (!existsSync(DIST)) {
  log(`GG/no-network: FAIL — ${DIST} does not exist. Build first: npx tsc -b packages/identity`);
  process.exit(1);
}

// ── A. the trap ────────────────────────────────────────────────────────────────────────────

function runSnippet(code, { preload }) {
  const args = preload ? ['--require', PRELOAD, '-e', code] : ['-e', code];
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

log('==> GG/no-network A1: the trap is armed (positive controls)');
for (const [label, code] of [
  ['fetch', "fetch('http://127.0.0.1:9/').then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})"],
  ['dns.resolveTxt', "require('node:dns').resolveTxt('_servanda.example.com',()=>{})"],
  ['dns.promises.resolveTxt', "require('node:dns').promises.resolveTxt('_servanda.example.com')"],
  ['https.request', "require('node:https').request('https://example.com/.well-known/servanda.json')"],
  ['net.connect', "require('node:net').connect(9,'127.0.0.1')"],
]) {
  const r = runSnippet(code, { preload: true });
  const out = `${r.stdout}${r.stderr}`;
  check(out.includes(DENIED), `${label} is denied under the preload`, out.split('\n')[0]?.slice(0, 90));
}

log('==> GG/no-network A2: the denial comes from the trap, not from an absent network');
{
  const r = runSnippet(
    "fetch('http://127.0.0.1:9/').then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})",
    { preload: false },
  );
  const out = `${r.stdout}${r.stderr}`;
  check(
    !out.includes(DENIED) && out.trim() !== '',
    'the same call without the preload fails differently',
    out.split('\n')[0]?.slice(0, 90),
  );
}

// ── B. the real package, under the trap ────────────────────────────────────────────────────

log('==> GG/no-network B: @servanda/identity answers all of §1 with networking denied');
{
  const r = spawnSync(process.execPath, ['--require', PRELOAD, EXERCISE], { encoding: 'utf8' });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  let report = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('REPORT ')) {
      try {
        report = JSON.parse(line.slice('REPORT '.length));
      } catch {
        /* not the report line */
      }
    }
  }
  check(r.status === 0, 'the exercise exited cleanly', `exit=${r.status} ${stderr.slice(0, 160)}`);
  check(report !== null, 'the exercise reported its results');
  if (report !== null) {
    for (const [label, ok] of Object.entries(report.checks ?? {})) {
      check(ok === true, `  §1: ${label}`);
    }
    check(
      report.trapWouldHaveCaught === true,
      'a transport that reaches out IS caught in this very process',
      'control inside the trapped child',
    );
    check(
      report.deniedByIdentity === 0,
      'no identity code path tripped the trap',
      `${report.deniedByIdentity} denial(s)`,
    );
  }
  check(
    !stderr.includes(DENIED),
    'nothing escaped as an unhandled network denial',
    stderr.slice(0, 160),
  );
}

// ── C. static import-graph audit ───────────────────────────────────────────────────────────

log('==> GG/no-network C: static import-graph audit of the shipped modules');

const FORBIDDEN = [
  /from\s+['"]node:(net|tls|dns|http|https|http2|dgram)['"]/,
  /require\(\s*['"]node:(net|tls|dns|http|https|http2|dgram)['"]\s*\)/,
  /from\s+['"](undici|node-fetch|axios|got|ws)['"]/,
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
    else if (p.endsWith('.js') && statSync(p).isFile()) out.push(p);
  }
  return out;
}

const roots = ['identity', 'crypto', 'types'].map((p) => join(PKG, '..', p, 'dist'));
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
  log(`GG/no-network: FAIL (${failures} check(s) failed)`);
  process.exit(1);
}
log(`GG/no-network: PASS — trap armed, ${scanned} shipped modules scanned, §1 answered offline`);
