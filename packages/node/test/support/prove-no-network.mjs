#!/usr/bin/env node
/**
 * GATE GA, requirement 2: "The node answers all five MCP tools with networking disabled —
 * PROVE it, don't assert it."
 *
 * Two independent proofs, both of which must pass:
 *
 *  A. RUNTIME. The node runs in a child process under `--require deny-network.cjs`, which
 *     replaces net/tls/dns/http/https/http2/dgram/fetch/WebSocket with throwers. Three positive
 *     controls confirm the trap is armed (a child that tries fetch / dns.lookup / net.connect
 *     must die with NETWORK_ACCESS_DENIED) and one negative control confirms the denial comes
 *     from the trap rather than from an absent network (the same fetch WITHOUT the preload must
 *     fail with a connection error, not NETWORK_ACCESS_DENIED). Only then is the real node
 *     spawned and driven through initialize + tools/list + all five tools over stdio.
 *
 *  B. STATIC. The shipped module graph (@servanda/node, /vault, /crypto, /types) is scanned
 *     for any import of a network module or use of fetch/XHR. Nothing may match. This closes
 *     the hole the runtime trap cannot: a bypass through a lower-level binding.
 *
 * Exits non-zero, loudly, on any failure. Run directly: node prove-no-network.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { derivePersona, mnemonicToSeed } from '@servanda/crypto';
import { Vault } from '@servanda/vault';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..', '..');
const PRELOAD = join(HERE, 'deny-network.cjs');
const ENTRY = join(PKG, 'dist', 'bin', 'servanda-node.js');
const DENIED = 'NETWORK_ACCESS_DENIED';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ' +
  'abandon art';
const PASSPHRASE = 'correct horse battery staple';

let failures = 0;
const log = (s) => process.stdout.write(`${s}\n`);

if (!existsSync(ENTRY)) {
  log(`GA/no-network: FAIL — ${ENTRY} does not exist. Build first: npx tsc -b packages/node`);
  process.exit(1);
}
function check(ok, label, detail = '') {
  log(`    ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
}

// ── A. runtime controls ───────────────────────────────────────────────────────────────────

function runSnippet(code, { preload }) {
  const args = preload ? ['--require', PRELOAD, '-e', code] : ['-e', code];
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

log('==> GA/no-network A1: the trap is armed (positive controls)');
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

log('==> GA/no-network A2: the denial comes from the trap, not from an absent network');
{
  const r = runSnippet(
    "fetch('http://127.0.0.1:9/').then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})",
    { preload: false },
  );
  const out = `${r.stdout}${r.stderr}`;
  check(!out.includes(DENIED), 'the same call without the preload fails differently', out.split('\n')[0]?.slice(0, 90));
}

// ── A3. the real node, under the trap ─────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'servanda-nonet-'));
const seed = mnemonicToSeed(MNEMONIC);
const me = derivePersona(seed, 0);
const other = derivePersona(seed, 1);
const vault = Vault.create({ dir, passphrase: PASSPHRASE });
vault.putPersona({
  persona_id: me.personaId,
  persona_index: 0,
  label: 'me',
  scope_kind: 'personal',
  org_root: null,
  private_key: me.privateKey,
  created_at: new Date().toISOString(),
});

const REQUESTS = [
  { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ga', version: '0' } } },
  { method: 'notifications/initialized' },
  { id: 2, method: 'tools/list', params: {} },
  { id: 3, method: 'tools/call', params: { name: 'commit', arguments: { intent: 'ship the gate', owed_to: other.personaId, due: null, propose: true } } },
  { id: 4, method: 'tools/call', params: { name: 'expect', arguments: { expect: 'the review', from: 'someone@example.com' } } },
  { id: 5, method: 'tools/call', params: { name: 'open_loops', arguments: { view: 'all' } } },
  { id: 6, method: 'tools/call', params: { name: 'brief', arguments: { persona: null } } },
  { id: 7, method: 'tools/call', params: { name: 'confirm', arguments: { id: 'deadbeef', decision: 'dismiss' } } },
];

log('==> GA/no-network A3: the node answers all five §7 tools with networking denied');

const child = spawn(process.execPath, ['--require', PRELOAD, ENTRY], {
  env: {
    ...process.env,
    SERVANDA_VAULT: dir,
    SERVANDA_PASSPHRASE: PASSPHRASE,
    SERVANDA_PERSONA: me.personaId,
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdoutBuf = '';
let stderrBuf = '';
const responses = new Map();
child.stdout.on('data', (d) => {
  stdoutBuf += d.toString();
  let i;
  while ((i = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, i).trim();
    stdoutBuf = stdoutBuf.slice(i + 1);
    if (line) {
      try {
        const msg = JSON.parse(line);
        responses.set(msg.id, msg);
      } catch {
        /* not a JSON-RPC line */
      }
    }
  }
});
child.stderr.on('data', (d) => {
  stderrBuf += d.toString();
});

for (const r of REQUESTS) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...r })}\n`);
child.stdin.end();

const exitCode = await new Promise((resolve) => child.on('close', resolve));

check(exitCode === 0, 'the node exited cleanly', `exit=${exitCode}`);
check(!stderrBuf.includes(DENIED), 'the node never touched a network primitive', stderrBuf.slice(0, 200));

const init = responses.get(1);
check(init?.result?.serverInfo?.name === 'servanda-node', 'initialize answered');
const tools = responses.get(2);
const toolNames = (tools?.result?.tools ?? []).map((t) => t.name).sort();
check(
  JSON.stringify(toolNames) === JSON.stringify(['brief', 'commit', 'confirm', 'expect', 'open_loops']),
  'tools/list returns exactly the five §7 tools',
  toolNames.join(','),
);

for (const [id, tool, wantError] of [
  [3, 'commit', false],
  [4, 'expect', false],
  [5, 'open_loops', false],
  [6, 'brief', false],
  // `confirm` on an unknown id must REFUSE — an answered refusal is still an answer, and it
  // proves the tool ran rather than being silently absent.
  [7, 'confirm', true],
]) {
  const r = responses.get(id);
  const isError = r?.result?.isError === true;
  check(r !== undefined && r.error === undefined, `${tool} answered over stdio`);
  check(isError === wantError, `${tool} outcome as expected`, `isError=${isError}`);
}

const proposed = responses.get(3)?.result?.structuredContent;
check(proposed?.state === 'proposed' && typeof proposed?.edge_id === 'string',
  'commit produced a proposed edge with no second participant present (M-10)');

rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

// ── B. static import-graph audit ──────────────────────────────────────────────────────────

log('==> GA/no-network B: static import-graph audit of the shipped modules');

const FORBIDDEN = [
  /from\s+['"]node:(net|tls|dns|http|https|http2|dgram)['"]/,
  /require\(\s*['"]node:(net|tls|dns|http|https|http2|dgram)['"]\s*\)/,
  /from\s+['"](undici|node-fetch|axios|got|ws)['"]/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
];

function jsFiles(root, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) jsFiles(p, out);
    else if (p.endsWith('.js') && statSync(p).isFile()) out.push(p);
  }
  return out;
}

const roots = ['node', 'vault', 'crypto', 'types'].map((p) => join(PKG, '..', p, 'dist'));
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
  log(`GA/no-network: FAIL (${failures} check(s) failed)`);
  process.exit(1);
}
log(`GA/no-network: PASS — trap armed, ${scanned} shipped modules scanned, five tools answered offline`);
