#!/usr/bin/env bash
# GATE GE — Client surfaces.
#
# A stage is done only when its gate passes. This script is the definition of done for the
# three renderings of the register, and it asserts four things:
#
#   1. The brief renders inside its 100 ms budget from a local node, measured, with the
#      number printed and the gate failing on regression rather than warning about it.
#   2. Every action on the web surface is reachable and operable without a pointer.
#   3. Zero forbidden vocabulary and zero exclamation marks in anything a person reads —
#      scanned over RENDERED OUTPUT and the string table, never over source identifiers.
#   4. M-12 has a named test in this layer and must-coverage registers it.
set -euo pipefail

cd "$(dirname "$0")/.."

PKGS=(packages/client-web packages/tui packages/brief-email)
BUDGET_MS=100

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

# The vocabulary law, over what a person actually reads: the rendered web surface, the
# rendered terminal frames, the rendered email, and the string table itself. Source
# identifiers are deliberately out of scope — `OpenLoopItem` may say what it likes.
echo "==> GE: vocabulary and register"
node --input-type=module -e "
import {
  FORBIDDEN_TERMS, FixtureNodeClient, allCopyStrings, appEl, loadApp, makeFixture,
  scanExclamations, scanVocabulary, visibleText,
} from './packages/client-web/dist/index.js';
import { frameLines } from './packages/tui/dist/index.js';
import { renderBriefEmail } from './packages/brief-email/dist/index.js';

const NOW = '2026-03-01T09:00:00Z';
const fixture = makeFixture(24, NOW);
const client = new FixtureNodeClient(fixture);
const pending = { items: fixture.pending };

const read = [];
for (const surface of ['brief', 'owe', 'waiting', 'closed', 'inbox']) {
  const app = await loadApp(client, { surface, now: NOW, pending });
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
console.log(\`    scanned \${read.length} user-facing strings across web, terminal and email\`);
console.log(\`    forbidden terms checked: \${FORBIDDEN_TERMS.join(', ')}\`);
if (words.length > 0 || shouts.length > 0) {
  for (const v of [...words, ...shouts]) console.error(\`    FAIL \${v.term}: \${v.text}\`);
  console.error(\`FAIL: \${words.length} vocabulary and \${shouts.length} register violations\`);
  process.exit(1);
}
console.log('    0 forbidden terms, 0 exclamation marks');

// A scanner that never fires is a scanner nobody can trust.
if (scanVocabulary(['Open the vault']).length !== 1 || scanExclamations(['Ship it!']).length !== 1) {
  console.error('FAIL: the vocabulary scanner does not detect a known violation');
  process.exit(1);
}
console.log('    scanner verified against a known violation');
"

echo "==> GE: client suites"
npx vitest run packages/client-web/test packages/tui/test packages/brief-email/test --reporter=dot

echo "==> GE: named MUST test for this layer"
if [ ! -f packages/client-web/test/musts/M-12.test.ts ]; then
  echo "FAIL: missing named MUST test packages/client-web/test/musts/M-12.test.ts" >&2
  exit 1
fi
coverage="$(bash gates/must-coverage.sh 2>&1 || true)"
if ! printf '%s' "${coverage}" | grep -qE "ok +M-12\b"; then
  echo "FAIL: must-coverage does not register M-12" >&2
  printf '%s\n' "${coverage}" >&2
  exit 1
fi
printf '    %s\n' "$(printf '%s' "${coverage}" | grep -E "ok +M-12\b")"

echo
echo "GATE GE: PASS"
