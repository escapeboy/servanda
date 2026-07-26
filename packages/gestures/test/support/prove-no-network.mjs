#!/usr/bin/env node
/**
 * GATE GL, requirement 5: no gesture path touches a network, proved the way gate GA proves
 * it for the node rather than asserted in prose.
 *
 * The reason this matters more here than almost anywhere else in the product: a gesture is
 * the one surface whose input is written by a stranger. A package that both reads
 * attacker-authored text and can open a connection is one bug away from being an exfiltration
 * channel. So it cannot open one, and this is the proof.
 *
 *  A. RUNTIME. Every gesture path — both adapters, all three card kinds, the reaction
 *     resolver over the whole hostile corpus, rendering, and delivery through an injected
 *     poster — runs in a child process under `--require deny-network.cjs`, which replaces
 *     net/tls/dns/http/https/http2/dgram/fetch/WebSocket with throwers. Positive controls
 *     confirm the trap is armed; a negative control confirms the denial comes from the trap
 *     rather than from an absent network.
 *
 *  B. STATIC. The shipped module graph of @servanda/gestures is scanned for any import of a
 *     network module or use of fetch/XHR/WebSocket. Nothing may match.
 *
 * Exits non-zero, loudly, on any failure. Run directly: node prove-no-network.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..', '..');
const PACKAGES = join(PKG, '..');
const PRELOAD = join(PACKAGES, 'node', 'test', 'support', 'deny-network.cjs');
const DIST = join(PKG, 'dist');
const DENIED = 'NETWORK_ACCESS_DENIED';

let failures = 0;
const log = (s) => process.stdout.write(`${s}\n`);

function check(ok, label, detail = '') {
  log(`    ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
}

if (!existsSync(PRELOAD)) {
  log(`GL/no-network: FAIL — the network trap is not at ${PRELOAD}`);
  process.exit(1);
}
if (!existsSync(join(DIST, 'index.js'))) {
  log(`GL/no-network: FAIL — ${DIST} does not exist. Build first: npx tsc -b packages/gestures`);
  process.exit(1);
}

// ── A1/A2. the trap, and proof that it is the trap ────────────────────────────────────────

function runSnippet(code, { preload }) {
  const args = preload ? ['--require', PRELOAD, '-e', code] : ['-e', code];
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

log('==> GL/no-network A1: the trap is armed (positive controls)');
for (const [label, code] of [
  ['fetch', "fetch('http://127.0.0.1:9/').then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})"],
  ['dns.lookup', "require('node:dns').lookup('example.com',()=>{})"],
  ['net.connect', "require('node:net').connect(9,'127.0.0.1')"],
  ['https.request', "require('node:https').request('https://example.com')"],
]) {
  const r = runSnippet(code, { preload: true });
  const out = `${r.stdout}${r.stderr}`;
  check(out.includes(DENIED), `${label} is denied under the preload`, out.split('\n')[0]?.slice(0, 80));
}

log('==> GL/no-network A2: the denial comes from the trap, not from an absent network');
{
  const r = runSnippet(
    "fetch('http://127.0.0.1:9/').then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})",
    { preload: false },
  );
  const out = `${r.stdout}${r.stderr}`;
  check(!out.includes(DENIED), 'the same call without the preload fails differently', out.split('\n')[0]?.slice(0, 80));
}

// ── A3. every gesture path, under the trap ────────────────────────────────────────────────

const DRIVER = `
import {
  HOSTILE_TEXTS, MILA, chatContext, chatReactionEvent, chatReactionFixture,
  commentReactionEvent, commentReactionFixture, deliver, everyCard, fixtureDirectory,
  gestureCardEl, meetingEndCards, meetingFixture, prContext, resolveReaction, threeQuestions,
  reviewCommentUtterance, reviewCommentFixture, UNMAPPED_REACTIONS,
} from '${join(DIST, 'index.js')}';
import { renderToHtml, visibleText } from '@servanda/client-web';

let cards = 0;
let intents = 0;
const posted = [];
const poster = { post: (p) => void posted.push(p) };

function drive(resolution) {
  if (resolution.kind === 'unmapped') { intents++; return; }
  if (resolution.kind !== 'card') return;
  cards++;
  const card = resolution.card;
  threeQuestions(card);
  const tree = gestureCardEl(card);
  renderToHtml(tree);
  visibleText(tree);
  intents += card.actions.length;
  return card;
}

// Both adapters, over the whole hostile corpus and the benign one.
for (const body of [...HOSTILE_TEXTS, 'I will send it on Monday']) {
  for (const pending of ['pending-1', null]) {
    for (const who of ['mila', 'stefan']) {
      const chat = chatReactionEvent(chatReactionFixture(body, who), chatContext(pending));
      if (chat !== null) drive(resolveReaction(chat));
      const pr = commentReactionEvent(commentReactionFixture(who, body), prContext(pending));
      if (pr !== null) drive(resolveReaction(pr));
    }
  }
}

// Every unmapped reaction.
for (const reaction of Object.keys(UNMAPPED_REACTIONS)) {
  const hook = { ...chatReactionFixture(), reaction };
  drive(resolveReaction(chatReactionEvent(hook, chatContext())));
}

// The meeting-end card, and the plain utterance path.
for (const card of meetingEndCards(meetingFixture(), fixtureDirectory(), MILA)) {
  drive({ kind: 'card', card });
}
reviewCommentUtterance(reviewCommentFixture(), prContext());

// Delivery through the injected poster.
for (const card of everyCard()) await deliver(card, poster);

if (cards === 0 || intents === 0 || posted.length === 0) {
  console.error('DRIVER_EMPTY');
  process.exit(1);
}
console.log('DRIVER_OK ' + cards + ' ' + intents + ' ' + posted.length);
`;

log('==> GL/no-network A3: every gesture path runs with networking denied');
const child = spawn(process.execPath, ['--require', PRELOAD, '--input-type=module', '-e', DRIVER], {
  cwd: PKG,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdoutBuf = '';
let stderrBuf = '';
child.stdout.on('data', (d) => { stdoutBuf += d.toString(); });
child.stderr.on('data', (d) => { stderrBuf += d.toString(); });
const exitCode = await new Promise((resolve) => child.on('close', resolve));

check(exitCode === 0, 'the driver exited cleanly', `exit=${exitCode} ${stderrBuf.slice(0, 200)}`);
check(!stderrBuf.includes(DENIED), 'no gesture path touched a network primitive', stderrBuf.slice(0, 200));
const driven = stdoutBuf.trim().split('\n').find((l) => l.startsWith('DRIVER_OK'));
check(driven !== undefined, 'the driver reached the end', stdoutBuf.trim().slice(0, 120));
if (driven !== undefined) {
  const [, cards, intents, posted] = driven.split(' ');
  log(`         ${cards} cards rendered, ${intents} intents built, ${posted} placements delivered, offline`);
}

// ── B. static import-graph audit ──────────────────────────────────────────────────────────

log('==> GL/no-network B: static import-graph audit of the shipped modules');

const FORBIDDEN = [
  /from\s+['"]node:(net|tls|dns|http|https|http2|dgram|child_process)['"]/,
  /require\(\s*['"]node:(net|tls|dns|http|https|http2|dgram|child_process)['"]\s*\)/,
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

let scanned = 0;
const hits = [];
for (const file of jsFiles(DIST)) {
  scanned++;
  const text = readFileSync(file, 'utf8');
  for (const re of FORBIDDEN) {
    if (re.test(text)) hits.push(`${file.replace(PACKAGES, 'packages')}: ${re}`);
  }
}
check(scanned > 0, 'found built modules to scan', `${scanned} files`);
check(hits.length === 0, 'no shipped module imports a network primitive', hits.join(' | '));

// The scanner must be able to fail.
const armed = FORBIDDEN.some((re) => re.test("import { request } from 'node:https';\nawait fetch('x');"));
check(armed, 'the import scanner detects a known violation');

log('');
if (failures > 0) {
  log(`GL/no-network: FAIL (${failures} check(s) failed)`);
  process.exit(1);
}
log(`GL/no-network: PASS — trap armed, ${scanned} shipped modules scanned, every gesture path ran offline`);
