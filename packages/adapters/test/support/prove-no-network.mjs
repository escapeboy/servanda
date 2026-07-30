#!/usr/bin/env node
/**
 * GATE GJ, requirement 4: verification adapters are read-only and offline — PROVE it.
 *
 * Modelled on `packages/node/test/support/prove-no-network.mjs`, and held to the same standard:
 * a trap is only evidence if it is armed, and a denial is only evidence if it came from the trap
 * rather than from an absent network. Four proofs, all of which must pass:
 *
 *  A. RUNTIME. The adapters run in a child process under `--require deny-network.cjs`, which
 *     replaces net/tls/dns/http/https/http2/dgram/fetch/WebSocket with throwers. Positive
 *     controls confirm the trap trips; a negative control confirms the same call WITHOUT the
 *     preload fails differently. Only then are all three adapters driven to a real answer.
 *
 *  B. STATIC. The shipped module graph (@servanda/adapters and its dependencies) is scanned for
 *     any import of a network module or use of fetch/XHR. Nothing may match. `child_process` is
 *     permitted in exactly one file — the git adapter — and nowhere else.
 *
 *  C. THE CHILD PROCESS. The runtime trap covers Node, not a program Node spawns, so the git
 *     adapter is proved separately and directly: a shim on PATH records what it was actually
 *     invoked with. The argv must be allowlisted read-only plumbing, the environment must be
 *     scrubbed of the caller's git configuration and credentials, and a poisoned ambient
 *     variable must not reach the child.
 *
 *  D. THE ALLOWLIST ITSELF. Every subcommand on it is checked against the set of git commands
 *     that can reach a remote. A shipped allowlist containing `fetch` would pass A, B and C.
 *
 * Exits non-zero, loudly, on any failure. Run directly: node prove-no-network.mjs
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..', '..');
const PRELOAD = join(HERE, 'deny-network.cjs');
const DIST = join(PKG, 'dist', 'index.js');
const REPO = join(PKG, '..', '..', 'fixtures', 'archaeology-repo', 'repo');
const DENIED = 'NETWORK_ACCESS_DENIED';

let failures = 0;
const log = (s) => process.stdout.write(`${s}\n`);

if (!existsSync(DIST)) {
  log(`GJ/no-network: FAIL — ${DIST} does not exist. Build first: npx tsc -b packages/adapters`);
  process.exit(1);
}

function check(ok, label, detail = '') {
  log(`    ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
}

// ── A1/A2. the trap, and the proof that it is the trap ────────────────────────────────────

function runSnippet(code, { preload }) {
  const args = preload ? ['--require', PRELOAD, '-e', code] : ['-e', code];
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

log('==> GJ/no-network A1: the trap is armed (positive controls)');
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

log('==> GJ/no-network A2: the denial comes from the trap, not from an absent network');
{
  const r = runSnippet(
    "fetch('http://127.0.0.1:9/').then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})",
    { preload: false },
  );
  const out = `${r.stdout}${r.stderr}`;
  check(!out.includes(DENIED), 'the same call without the preload fails differently', out.split('\n')[0]?.slice(0, 90));
}

// ── A3. all three adapters, under the trap ────────────────────────────────────────────────

log('==> GJ/no-network A3: all three adapters answer with networking denied');

const workspace = mkdtempSync(join(tmpdir(), 'servanda-gj-ws-'));
writeFileSync(join(workspace, 'report.md'), 'done\n');

const ENVELOPE_ID = 'c'.repeat(64);
const CHILD = `
const A = await import(${JSON.stringify(pathToFileURL(DIST).href)});
const OWNER = 'a'.repeat(64);
const commitment = (refs) => ({
  v: 'servanda/0.1', type: 'commitment', owner: OWNER, owed_to: 'b'.repeat(64),
  due: null, conditions: [], evidence_refs: refs, created_at: '2026-07-01T09:00:00Z',
  source: 'explicit', confidence: 1, commitment_hash: 'b'.repeat(64),
});
const envelope = {
  v: 'servanda/0.1', type: 'envelope', id: ${JSON.stringify(ENVELOPE_ID)}, source: 'ci',
  kind: 'check_run', occurred_at: '2026-07-18T12:00:00Z', received_at: '2026-07-18T12:00:03Z',
  actor: { label: 'ci' },
  payload: { check_run_id: 1, text: 'ci / test', status: 'completed', conclusion: 'success',
             completed_at: '2026-07-18T12:00:00Z', head_sha: 'a'.repeat(40) },
  refs: [], persona: OWNER,
};
const ctx = {
  now: '2026-07-26T10:00:00Z',
  repo: { path: ${JSON.stringify(REPO)} },
  workspace: { root: ${JSON.stringify(workspace)} },
  envelopes: [envelope],
};
const out = {
  git: A.verifyCommitment(commitment([{ kind: 'commit', value: 'branch:main' }]), ctx),
  file: A.verifyCommitment(commitment([{ kind: 'file', value: 'report.md' }]), ctx),
  ci: A.verifyCommitment(commitment([{ kind: 'envelope', value: ${JSON.stringify(ENVELOPE_ID)} }]), ctx),
  none: A.verifyCommitment(commitment([{ kind: 'url', value: 'https://forge.example/pr/1' }]), ctx),
};
console.log('RESULT ' + JSON.stringify(out));
`;

{
  const r = spawnSync(process.execPath, ['--require', PRELOAD, '--input-type=module', '-e', CHILD], {
    encoding: 'utf8',
  });
  check(r.status === 0, 'the adapters exited cleanly under the trap', `exit=${r.status}`);
  check(!`${r.stdout}${r.stderr}`.includes(DENIED), 'no adapter touched a network primitive', r.stderr.slice(0, 200));

  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  if (!check(line !== undefined, 'the adapters produced a result', r.stderr.slice(0, 300))) {
    // nothing more can be asserted about an absent result
  } else {
    const out = JSON.parse(line.slice('RESULT '.length));
    for (const name of ['git', 'file', 'ci']) {
      check(out[name]?.verifiable === true, `${name} observed offline`, JSON.stringify(out[name]?.reason ?? ''));
      check(/^[0-9a-f]{64}$/.test(out[name]?.evidence_hash ?? ''), `${name} produced an evidence hash`);
    }
    check(out.git?.bundle?.satisfied === true && out.file?.bundle?.satisfied === true && out.ci?.bundle?.satisfied === true,
      'all three observations were satisfied');
    check(out.none?.verifiable === false && out.none?.evidence_hash === null,
      'a url ref is NotVerifiable offline, with a null hash (M-8)', String(out.none?.reason));
  }
}
rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

// ── B. static import-graph audit ──────────────────────────────────────────────────────────

log('==> GJ/no-network B: static import-graph audit of the shipped modules');

const FORBIDDEN = [
  /from\s+['"]node:(net|tls|dns|http|https|http2|dgram)['"]/,
  /require\(\s*['"]node:(net|tls|dns|http|https|http2|dgram)['"]\s*\)/,
  /from\s+['"](undici|node-fetch|axios|got|ws)['"]/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
];
const CHILD_PROCESS = /node:child_process/;

function jsFiles(root, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) jsFiles(p, out);
    else if (p.endsWith('.js') && statSync(p).isFile()) out.push(p);
  }
  return out;
}

const roots = [join(PKG, 'dist'), join(PKG, '..', 'crypto', 'dist'), join(PKG, '..', 'types', 'dist')];
let scanned = 0;
const hits = [];
const spawners = [];
for (const root of roots) {
  for (const file of jsFiles(root)) {
    scanned++;
    const text = readFileSync(file, 'utf8');
    for (const re of FORBIDDEN) if (re.test(text)) hits.push(`${file}: ${re}`);
    if (CHILD_PROCESS.test(text)) spawners.push(file);
  }
}
check(scanned > 0, 'found built modules to scan', `${scanned} files`);
check(hits.length === 0, 'no shipped module imports a network primitive', hits.join(' | '));
check(
  spawners.length === 1 && spawners[0].endsWith(join('dist', 'classes', 'git.js')),
  'exactly one shipped module can spawn anything, and it is the git adapter',
  spawners.join(', ') || 'none',
);

// ── C. what the git child is actually invoked with ────────────────────────────────────────

log('==> GJ/no-network C: the git child is read-only plumbing in a scrubbed environment');

const { runGit, GIT_ALLOWLIST, gitAdapter } = await import(pathToFileURL(DIST).href);

const shimDir = mkdtempSync(join(tmpdir(), 'servanda-gj-git-'));
const record = join(shimDir, 'invocations.jsonl');
writeFileSync(
  join(shimDir, 'git'),
  `#!/bin/sh
{
  printf '{"argv":['
  sep=""
  for a in "$@"; do printf '%s"%s"' "$sep" "$a"; sep=","; done
  printf '],"env":"'
  env | tr '\\n' ' '
  printf '"}\\n'
} >> ${JSON.stringify(record)}
exit 0
`,
);
chmodSync(join(shimDir, 'git'), 0o755);

const realPath = process.env.PATH;
// A credential and a proxy in the ambient environment. Neither may reach the child.
process.env.PATH = `${shimDir}:${realPath}`;
process.env.GITHUB_TOKEN = 'ghp_should_never_be_passed';
process.env.HTTPS_PROXY = 'http://proxy.invalid:3128';
process.env.GIT_CONFIG_GLOBAL = '/home/someone/.gitconfig';

try {
  gitAdapter.observe(
    { commitment_hash: 'b'.repeat(64), evidence_refs: [] },
    { kind: 'commit', value: 'branch:main' },
    { now: '2026-07-26T10:00:00Z', repo: { path: REPO } },
  );
} finally {
  process.env.PATH = realPath;
  delete process.env.GITHUB_TOKEN;
  delete process.env.HTTPS_PROXY;
  delete process.env.GIT_CONFIG_GLOBAL;
}

const invocations = existsSync(record)
  ? readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];
check(invocations.length > 0, 'the shim recorded the invocation', `${invocations.length} call(s)`);
for (const call of invocations) {
  const subcommand = call.argv.find((a) => !a.startsWith('-') && a !== REPO);
  check(GIT_ALLOWLIST.includes(subcommand), 'the subcommand is on the allowlist', String(subcommand));
  check(!/GITHUB_TOKEN/.test(call.env), 'no credential reached the child');
  check(!/HTTPS_PROXY|HTTP_PROXY|ALL_PROXY/.test(call.env), 'no proxy setting reached the child');
  check(/GIT_CONFIG_GLOBAL=\/dev\/null/.test(call.env), "the caller's git config was replaced");
  check(/GIT_TERMINAL_PROMPT=0/.test(call.env), 'terminal prompting is disabled');
}
rmSync(shimDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

let refusedFetch = false;
try {
  runGit(REPO, ['fetch', 'origin']);
} catch (err) {
  refusedFetch = /RefusedGitSubcommand/.test(String(err?.name)) || /allowlist/.test(String(err));
}
check(refusedFetch, 'a subcommand that could reach a remote is refused before it runs');

// ── D. the allowlist is not merely enforced but correct ───────────────────────────────────

log('==> GJ/no-network D: nothing on the allowlist can reach a remote');
const REMOTE_CAPABLE = [
  'fetch', 'pull', 'push', 'clone', 'ls-remote', 'remote', 'submodule', 'archive',
  'send-email', 'request-pull', 'fetch-pack', 'send-pack', 'upload-pack', 'daemon', 'credential',
];
for (const name of GIT_ALLOWLIST) {
  check(!REMOTE_CAPABLE.includes(name), `"${name}" cannot reach a remote`);
}
check(GIT_ALLOWLIST.length <= 4, 'the allowlist stayed small', `${GIT_ALLOWLIST.length} entries`);

log('');
if (failures > 0) {
  log(`GJ/no-network: FAIL (${failures} check(s) failed)`);
  process.exit(1);
}
log(`GJ/no-network: PASS — trap armed, ${scanned} shipped modules scanned, three adapters observed offline`);
