#!/usr/bin/env bash
# GATE GE — Client surfaces.
#
# A stage is done only when its gate passes. This script is the definition of done for the
# three renderings of the register and for the four product surfaces built on top of them,
# and it asserts eight things:
#
#   1. The brief renders inside its 100 ms budget from a local node, measured, with the
#      number printed and the gate failing on regression rather than warning about it.
#   2. Every action on every surface is reachable and operable without a pointer.
#   3. Zero forbidden vocabulary and zero exclamation marks in anything a person reads —
#      scanned over RENDERED OUTPUT and the string table, never over source identifiers.
#   4. The first-run path additionally uses no technical vocabulary at all, and the word
#      "install" does not appear on it.
#   5. A proof page renders complete with no plaintext available (M-15), and shows no words
#      without both parties' consent.
#   6. A promise nobody shared never reaches the team surface (M-4).
#   7. M-4, M-11, M-12 and M-15 have named tests in this layer and must-coverage registers
#      each of them.
#   8. The suites pass.
#
# Every scanner in here is checked against a known violation. A check that cannot fail
# proves nothing, so each one is made to fail on purpose before it is trusted.
set -euo pipefail

cd "$(dirname "$0")/.."

PKGS=(packages/client-web packages/tui packages/brief-email)
BUDGET_MS=100
MUSTS=(M-4 M-11 M-12 M-15)

echo "==> GE: workspace links"
for pkg in "${PKGS[@]}"; do
  if ! node -e "require.resolve('@servanda/types', { paths: ['${PWD}/${pkg}/src'] })" >/dev/null 2>&1; then
    echo "FAIL: @servanda/types is not resolvable from ${pkg} — run 'pnpm install'" >&2
    exit 1
  fi
done
echo "    @servanda/types resolves from all three surfaces"

echo "==> GE: typecheck"
npx tsc -b packages/client-web packages/tui packages/brief-email

# Measured in a fresh process against a local stand-in node, over a full register at §7's
# `limit` ceiling. The worst run is the one that has to fit, not the median.
echo "==> GE: brief latency budget (${BUDGET_MS} ms)"
node --input-type=module -e "
import { FixtureNodeClient, appEl, loadApp, makeFixture, renderToHtml } from './packages/client-web/dist/index.js';

const NOW = '2026-03-01T09:00:00Z';
const BUDGET = ${BUDGET_MS};
const fixture = makeFixture(500, NOW);
const client = new FixtureNodeClient(fixture);
const pending = { items: fixture.pending };

const timings = [];
for (let i = 0; i < 20; i++) {
  const started = performance.now();
  const app = await loadApp(client, { surface: 'brief', now: NOW, pending });
  const html = renderToHtml(appEl(app));
  timings.push(performance.now() - started);
  if (html.length === 0) { console.error('FAIL: brief rendered nothing'); process.exit(1); }
}
timings.sort((a, b) => a - b);
const median = timings[Math.floor(timings.length / 2)];
const worst = timings[timings.length - 1];
console.log(\`    500-item register: median \${median.toFixed(2)} ms, worst \${worst.toFixed(2)} ms\`);
if (worst >= BUDGET) {
  console.error(\`FAIL: worst brief render \${worst.toFixed(2)} ms exceeds the \${BUDGET} ms budget\`);
  process.exit(1);
}
"

# The vocabulary law, over what a person actually reads: every rendered web surface, the
# rendered terminal frames, the rendered email, and the string table itself. Source
# identifiers are deliberately out of scope — `OpenLoopItem` may say what it likes.
echo "==> GE: vocabulary and register"
node --input-type=module -e "
import {
  FIRST_RUN_FORBIDDEN, FORBIDDEN_TERMS, FixtureNodeClient, RECOVERY_WORDS, allCopyStrings, appEl,
  buildOnboarding, loadApp, makeFixture, makeIntegrationsFixture, makeProofFixture, makeTeamFixture,
  onboardingStrings, scanExclamations, scanFirstRun, scanVocabulary, visibleText,
} from './packages/client-web/dist/index.js';
import { frameLines } from './packages/tui/dist/index.js';
import { renderBriefEmail } from './packages/brief-email/dist/index.js';

const NOW = '2026-03-01T09:00:00Z';
const fixture = makeFixture(24, NOW);
const client = new FixtureNodeClient(fixture);
const inputs = {
  now: NOW,
  pending: { items: fixture.pending },
  team: makeTeamFixture(NOW),
  integrations: makeIntegrationsFixture(),
  onboarding: { recoveryWords: RECOVERY_WORDS },
  proof: makeProofFixture({ plaintext: 'the words of the promise', viewer: 'owner' }),
};

const SURFACES = ['brief', 'owe', 'waiting', 'closed', 'inbox', 'team', 'trust', 'first-run', 'proof'];
const read = [];
for (const surface of SURFACES) {
  const app = await loadApp(client, { surface, ...inputs });
  read.push(...visibleText(appEl(app)));
  read.push(...frameLines({ app, cursor: 0 }));
  if (surface === 'brief') {
    const email = renderBriefEmail(app.brief);
    read.push(email.subject, ...email.text.split('\n'));
  }
}
read.push(...allCopyStrings());

const words = scanVocabulary(read);
const shouts = scanExclamations(read);
console.log(\`    scanned \${read.length} user-facing strings across \${SURFACES.length} surfaces, terminal and email\`);
console.log(\`    forbidden terms checked: \${FORBIDDEN_TERMS.join(', ')}\`);
if (words.length > 0 || shouts.length > 0) {
  for (const v of [...words, ...shouts]) console.error(\`    FAIL \${v.term}: \${v.text}\`);
  console.error(\`FAIL: \${words.length} vocabulary and \${shouts.length} register violations\`);
  process.exit(1);
}
console.log('    0 forbidden terms, 0 exclamation marks');

// The non-technical-default law, on the one path where it is absolute.
const firstRun = onboardingStrings(buildOnboarding({ recoveryWords: RECOVERY_WORDS }));
const technical = scanFirstRun(firstRun);
if (technical.length > 0) {
  for (const v of technical) console.error(\`    FAIL \${v.term}: \${v.text}\`);
  console.error('FAIL: the first-run path uses vocabulary it may not use');
  process.exit(1);
}
if (firstRun.join(' ').toLowerCase().includes('install')) {
  console.error('FAIL: the word install appears on the first-run path');
  process.exit(1);
}
console.log(\`    first run: \${firstRun.length} sentences, 0 of \${FIRST_RUN_FORBIDDEN.length} technical terms\`);

// A scanner that never fires is a scanner nobody can trust.
if (scanVocabulary(['Open the vault']).length !== 1 || scanExclamations(['Ship it!']).length !== 1) {
  console.error('FAIL: the vocabulary scanner does not detect a known violation');
  process.exit(1);
}
if (scanFirstRun(['Install the desktop app']).length === 0 || scanFirstRun(['Run it from the terminal']).length === 0) {
  console.error('FAIL: the first-run scanner does not detect a known violation');
  process.exit(1);
}
console.log('    both scanners verified against known violations');
"

# Full keyboard operation is a platform floor, so it is walked rather than asserted: every
# surface, every control, reached in document order with no pointer anywhere.
echo "==> GE: keyboard-only walkthrough, every surface"
node --input-type=module -e "
import {
  FixtureNodeClient, RECOVERY_WORDS, appEl, focusOrder, loadApp, makeFixture,
  makeIntegrationsFixture, makeProofFixture, makeTeamFixture, nextStop, pointerOnlyControls, stopsFor,
} from './packages/client-web/dist/index.js';

const NOW = '2026-03-01T09:00:00Z';
const fixture = makeFixture(24, NOW);
const client = new FixtureNodeClient(fixture);
const inputs = {
  now: NOW,
  pending: { items: fixture.pending },
  team: makeTeamFixture(NOW),
  integrations: makeIntegrationsFixture(),
  onboarding: { recoveryWords: RECOVERY_WORDS },
  proof: makeProofFixture({ plaintext: 'the words of the promise', viewer: 'owner' }),
};

const SURFACES = ['brief', 'owe', 'waiting', 'closed', 'inbox', 'team', 'trust', 'first-run', 'proof'];
let reached = 0;
for (const surface of SURFACES) {
  const app = await loadApp(client, { surface, ...inputs });
  const tree = appEl(app);

  const stranded = pointerOnlyControls(tree);
  if (stranded.length > 0) {
    console.error(\`FAIL \${surface}: \${stranded.length} control(s) a pointer can reach and a keyboard cannot\`);
    process.exit(1);
  }

  const stops = focusOrder(tree);
  if (stops.length === 0) {
    console.error(\`FAIL \${surface}: nothing is reachable from the keyboard at all\`);
    process.exit(1);
  }
  for (const stop of stops) {
    if (stop.name.length === 0) {
      console.error(\`FAIL \${surface}: a focus stop has no name a screen reader could announce\`);
      process.exit(1);
    }
  }

  // Every action the view model offers is reached by the walk, in the same order.
  const offered = stopsFor(app).filter((s) => s.kind === 'action').map((s) => s.id);
  const walked = stops.map((s) => s.actionId).filter((id) => id !== null);
  if (JSON.stringify(offered) !== JSON.stringify(walked)) {
    console.error(\`FAIL \${surface}: the keyboard walk does not reach exactly the actions offered\`);
    console.error(\`    offered \${offered.length}, walked \${walked.length}\`);
    process.exit(1);
  }

  // Tab all the way round, and back to where it started.
  let index = 0;
  for (let i = 0; i < stops.length; i++) index = nextStop(stops, index);
  if (index !== 0) {
    console.error(\`FAIL \${surface}: Tab does not return to the first stop\`);
    process.exit(1);
  }
  reached += stops.length;
}
console.log(\`    \${SURFACES.length} surfaces, \${reached} focus stops, 0 stranded controls\`);

// The negative control: the check must be able to fail.
const trap = pointerOnlyControls({
  tag: 'div', attrs: {},
  children: [{ tag: 'div', attrs: { 'data-action': 'x:done' }, text: 'Mark done' }],
});
if (trap.length !== 1) {
  console.error('FAIL: the keyboard check does not detect a pointer-only control');
  process.exit(1);
}
console.log('    keyboard check verified against a known pointer-only control');
"

# The proof page is the surface that has to survive retention decay (§5.4, ADR-0004, M-15):
# once the plaintext is gone the certificate must be complete, not degraded.
echo "==> GE: a proof page renders with no plaintext"
node --input-type=module -e "
import { buildProof, makeProofFixture, proofDocument, proofEl, visibleText } from './packages/client-web/dist/index.js';

const WORDS = 'Migrate Acme to the new billing provider by 30 September';

// 1. The words are gone. The certificate is whole.
const decayed = buildProof(makeProofFixture({ plaintext: null }));
if (decayed.words !== null) { console.error('FAIL: words rendered when there are none'); process.exit(1); }
const doc = proofDocument(decayed);
for (const required of ['3'.repeat(64), 'a'.repeat(64), 'b'.repeat(64), '2026-06-02T10:15:00Z']) {
  if (!doc.includes(required)) {
    console.error(\`FAIL: the certificate is missing \${required.slice(0, 12)} without plaintext\`);
    process.exit(1);
  }
}
if (decayed.chain.length !== 4 || decayed.dates.length !== 4) {
  console.error('FAIL: the state chain or the dates did not survive retention decay');
  process.exit(1);
}
console.log(\`    with no plaintext: \${decayed.chain.length} chain steps, \${decayed.dates.length} dates, fingerprint and both keys, \${doc.length} bytes\`);

// 2. Present but unconsented, in every combination that is not both.
for (const disclosure of [undefined, { byOwner: false, byOwedTo: false }, { byOwner: true, byOwedTo: false }, { byOwner: false, byOwedTo: true }]) {
  const view = buildProof(makeProofFixture({ plaintext: WORDS, disclosure }));
  if (view.words !== null || visibleText(proofEl(view)).join(' ').includes(WORDS)) {
    console.error(\`FAIL: the words were shown with disclosure \${JSON.stringify(disclosure)}\`);
    process.exit(1);
  }
}
console.log('    words withheld by default and with one consent');

// 3. The check must be able to fail: with both consents the words DO appear.
const both = buildProof(makeProofFixture({ plaintext: WORDS, disclosure: { byOwner: true, byOwedTo: true } }));
if (both.words !== WORDS) {
  console.error('FAIL: the disclosure check cannot distinguish consent from refusal');
  process.exit(1);
}
console.log('    disclosure check verified against the consenting case');
"

# M-4 in the gate, not only in a test file: the surface that shows other people's promises
# is the one place visibility can leak, so the gate reads the rendered output itself.
echo "==> GE: an unshared promise never reaches the team surface"
node --input-type=module -e "
import {
  FixtureNodeClient, OTHER_SCOPE_KEY, TEAM_SCOPE_KEY, appEl, buildTeam, loadApp, makeFixture,
  makeTeamFixture, sharedWith, visibleText, walk,
} from './packages/client-web/dist/index.js';

const NOW = '2026-03-01T09:00:00Z';
const fixture = makeFixture(24, NOW);
const team = makeTeamFixture(NOW);

// The input deliberately contains all three kinds: shared here, shared elsewhere, unshared.
const kinds = team.publications.map((p) => (p.shared === null ? 'unshared' : p.shared.scope === TEAM_SCOPE_KEY ? 'here' : 'elsewhere'));
if (new Set(kinds).size !== 3) {
  console.error('FAIL: the fixture no longer contains a promise the surface must hide');
  process.exit(1);
}

const app = await loadApp(new FixtureNodeClient(fixture), { surface: 'team', now: NOW, pending: { items: fixture.pending }, team });
const read = visibleText(appEl(app)).join('\n');
const ids = walk(appEl(app)).map((n) => String(n.attrs?.['data-card'] ?? '')).filter((v) => v.length > 0);

for (const [id, text] of [['never-shared', 'Reply to the recruiter'], ['shared-elsewhere', 'Draft the pricing note']]) {
  if (ids.includes(id) || read.includes(text)) {
    console.error(\`FAIL: \${id} reached the team surface — visibility follows participation, never membership (M-4)\`);
    process.exit(1);
  }
}
if (!ids.includes('shared-here')) {
  console.error('FAIL: the promise a party did share is not on the surface either');
  process.exit(1);
}
console.log(\`    \${team.publications.length} promises in, 1 shared here, \${ids.length} on the surface\`);

// No inheritance, and an unset scope is not a wildcard.
if (sharedWith(OTHER_SCOPE_KEY, team.publications).length !== 1 || sharedWith('', team.publications).length !== 0) {
  console.error('FAIL: the scope filter inherits, or treats an unset scope as every scope');
  process.exit(1);
}

// The check must be able to fail: share it, and it appears.
const shared = buildTeam({ ...team, publications: team.publications.map((p) => (p.shared === null ? { ...p, shared: { scope: TEAM_SCOPE_KEY, by: 'a'.repeat(64) } } : p)) }, NOW);
if (!shared.entries.map((e) => e.id).includes('never-shared')) {
  console.error('FAIL: the visibility check cannot distinguish shared from unshared');
  process.exit(1);
}
console.log('    visibility check verified against a newly shared promise');
"

echo "==> GE: client suites"
npx vitest run packages/client-web/test packages/tui/test packages/brief-email/test \
  packages/client-local/test --reporter=dot

# The register must read the vault it lives in. `FixtureNodeClient` was for a long time the only
# NodeClient in the repository, so every suite above could pass while no shipped surface could
# show a real promise. This asserts the property those suites structurally cannot: a promise
# written through the local client comes back out, and the fixture client — asked the same
# question — does not know it.
echo "==> GE: the local register is not the fixture"
npx vitest run packages/client-local/test -t 'proving the data came from the vault' --reporter=dot

echo "==> GE: named MUST tests for this layer"
coverage="$(bash gates/must-coverage.sh 2>&1 || true)"
for must in "${MUSTS[@]}"; do
  file="packages/client-web/test/musts/${must}.test.ts"
  if [ ! -f "${file}" ]; then
    echo "FAIL: missing named MUST test ${file}" >&2
    exit 1
  fi
  if ! printf '%s' "${coverage}" | grep -qE "ok +${must}\b"; then
    echo "FAIL: must-coverage does not register ${must}" >&2
    printf '%s\n' "${coverage}" >&2
    exit 1
  fi
  printf '    %s\n' "$(printf '%s' "${coverage}" | grep -E "ok +${must}\b")"
done
printf '   %s\n' "$(printf '%s' "${coverage}" | grep -E 'MUSTs covered')"

echo
echo "GATE GE: PASS"
