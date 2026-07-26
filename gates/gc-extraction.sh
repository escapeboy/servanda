#!/usr/bin/env bash
# GATE GC — Extraction.
#
# "§3.4 extraction is tool-less, schema-bound, single-persona, and cannot propose someone else's
#  promise; the precision harness runs end to end and produces a report a human can grade."
#
# A stage is done only when its gate passes. This script is the definition of done for the
# extraction stream.
#
# The gate MUST NOT require a live API key. Without ANTHROPIC_API_KEY it exercises the stub path
# in full and says plainly that the live path was not exercised — it does not pretend otherwise.
set -euo pipefail

cd "$(dirname "$0")/.."

PKG=packages/extraction
REPORT="${SERVANDA_PRECISION_REPORT:-$(mktemp -t servanda-precision-XXXXXX).md}"
export REPORT
FIXTURE_ROOT="$(mktemp -d -t servanda-transcripts-XXXXXX)"
cleanup() { rm -rf "${FIXTURE_ROOT}"; }
trap cleanup EXIT

echo "==> GC: package present"
for f in package.json tsconfig.json src/index.ts src/extractor.ts src/routing.ts src/schema.ts; do
  if [ ! -f "${PKG}/${f}" ]; then
    echo "FAIL: missing ${PKG}/${f}" >&2
    exit 1
  fi
done
echo "    @servanda/extraction present"

echo "==> GC: typecheck"
npx tsc --noEmit -p "${PKG}/tsconfig.json"

echo "==> GC: named MUST tests exist"
required_musts=(
  "${PKG}/test/musts/M-01.test.ts"
  "${PKG}/test/musts/M-05.test.ts"
  "${PKG}/test/musts/M-06.test.ts"
)
for f in "${required_musts[@]}"; do
  if [ ! -f "${f}" ]; then
    echo "FAIL: missing named MUST test ${f}" >&2
    exit 1
  fi
done
echo "    ${#required_musts[@]} named MUST tests present"

echo "==> GC: suite"
npx vitest run "${PKG}/test" --reporter=dot

echo "==> GC: MUST coverage registers M-1, M-5, M-6"
# must-coverage.sh gates the whole constitution across every package; this gate owns three of the
# sixteen, so it asserts on those three and reports the rest without failing on another stream's
# gap. `|| true` keeps that scoping honest rather than silently swallowing a real failure: the
# grep below is what decides.
coverage="$(bash gates/must-coverage.sh 2>&1 || true)"
for id in M-1 M-5 M-6; do
  if ! grep -Eq "^  ok   ${id}[[:space:]]" <<<"${coverage}"; then
    echo "FAIL: ${id} does not register in gates/must-coverage.sh" >&2
    echo "${coverage}" >&2
    exit 1
  fi
  echo "    ${id} registers"
done
if grep -q "GATE must-coverage: PASS" <<<"${coverage}"; then
  echo "    (whole constitution covered)"
else
  echo "    note: other MUSTs are not yet covered — owned by other streams, not gated here"
fi

echo "==> GC: schema-boundedness — malformed, prose and injected responses yield ZERO commitments"
npx vitest run "${PKG}/test/schema-bound.test.ts" "${PKG}/test/musts/M-06.test.ts" --reporter=dot

echo "==> GC: build"
npx tsc -b "${PKG}/tsconfig.json"

echo "==> GC: harness runs end to end on a fixture (--dry-run, no API key, no spend)"
mkdir -p "${FIXTURE_ROOT}/-gate-fixture"
cat > "${FIXTURE_ROOT}/-gate-fixture/session-1.jsonl" <<'JSONL'
{"type":"user","timestamp":"2026-07-20T09:00:00.000Z","sessionId":"gate","cwd":"/tmp","message":{"role":"user","content":"I will send Maria the migration guide by Friday, and I promise to review the ADR."}}
{ this line is deliberately corrupt
{"type":"user","timestamp":"2026-07-20T09:05:00.000Z","sessionId":"gate","message":{"role":"user","content":[{"type":"tool_result","content":"not an utterance"}]}}
{"type":"user","timestamp":"2026-07-20T09:10:00.000Z","sessionId":"gate","cwd":"/tmp","message":{"role":"user","content":"Ivan said he would review the PR before the release goes out."}}
JSONL

node "${PKG}/dist/harness/cli.js" --dry-run \
  --root "${FIXTURE_ROOT}" \
  --days 3650 \
  --out "${REPORT}"

echo "==> GC: report is well formed"
node --input-type=module -e '
import { readFileSync } from "node:fs";
const report = readFileSync(process.env.REPORT, "utf8");
const required = [
  "# Servanda extraction — precision report",
  "Nothing in this report has been committed to anything",
  "The precision verdict is yours",
  "## Totals",
  "Envelopes produced",
  "Extraction rate",
  "### Routing (§3.4)",
  "| Ref | Correct? |",
];
let bad = 0;
for (const needle of required) {
  if (!report.includes(needle)) { console.error(`FAIL: report is missing ${JSON.stringify(needle)}`); bad++; }
}
// The fixture states one first-person promise and one reported one: the reported one must be an
// expectation, never something proposable (M-1).
if (!report.includes("expectation-only")) {
  console.error("FAIL: report does not show the expectation-only disposition");
  bad++;
}
if (report.includes("| Batches discarded whole (schema-bound) | 0 |") === false) {
  console.error("FAIL: the stub path should not discard any batch on the fixture");
  bad++;
}
if (bad === 0) console.log(`    report ok (${report.length} bytes)`);
process.exit(bad ? 1 : 0);
'

echo "==> GC: live path"
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "    ANTHROPIC_API_KEY is present; the live path is available but NOT exercised by this"
  echo "    gate (it costs money and is nondeterministic). Run the harness without --dry-run."
else
  echo "    ANTHROPIC_API_KEY is absent: the LIVE PATH WAS NOT EXERCISED."
  echo "    Everything above passed on the deterministic stub. That is a statement about"
  echo "    containment (tool-less, schema-bound, single-persona, M-1 routing), not about"
  echo "    extraction accuracy — precision is a human verdict on a live run."
  echo "    A live run needs no API key: scripts/precision-via-claude-cli.mjs drives the local"
  echo "    claude CLI. That backend is tool-less by CONFIGURATION and verifies it per run; the"
  echo "    API client is tool-less STRUCTURALLY, and remains the path this gate asserts against."
fi

echo
echo "GATE GC: PASS"
