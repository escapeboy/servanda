#!/usr/bin/env bash
# GATE G0 — Foundation.
#
# "100% of servanda-protocol vectors pass (canonicalization, hashing incl. the 5-field
#  commitment_hash invariance pair, signatures, derivation)."
#
# A stage is done only when its gate passes. This script is the definition of done for S0.
set -euo pipefail

cd "$(dirname "$0")/.."

VECTORS="${SERVANDA_VECTORS:-vendor/vectors}"

echo "==> G0: conformance vectors at ${VECTORS}"
if [ ! -d "${VECTORS}" ]; then
  echo "FAIL: vectors directory not found: ${VECTORS}" >&2
  exit 1
fi

# Every vector file must be present. A silently-missing file would let the suite "pass" while
# testing nothing — the failure mode the conformance suite exists to prevent.
#
# This list IS a coverage surface, exactly like the hand-written package list in
# connectors-email's no-network audit: a family that lands upstream and is never added here is a
# family nothing checks, and the gate still reports green. It went from six entries to eleven when
# §6.7 addressing and the §7 node-surface families arrived — the addressing ones had already been
# upstream for days without being noticed missing. It went to twelve when `brief-slots` landed,
# and the gate reported PASS in between: a family absent from this list is invisible to all three
# checks below, which is the whole reason the list is written out rather than globbed.
required=(
  canonicalization/jcs.json
  hashing/commitment-hash.json
  envelope/envelope-id.json
  envelope/bounds.json
  signatures/signatures.json
  derivation/persona-keys.json
  transitions/valid.json
  transitions/invalid.json
  addressing/inbox-records.json
  addressing/oob-bootstrap.json
  recovery/proof-of-possession.json
  node-surface/actions.json
  node-surface/act-tool.json
  node-surface/brief-slots.json
  node-surface/verification-levels.json
)
for f in "${required[@]}"; do
  if [ ! -f "${VECTORS}/${f}" ]; then
    echo "FAIL: missing vector file ${VECTORS}/${f}" >&2
    exit 1
  fi
done
echo "    all ${#required[@]} vector files present"
export G0_REQUIRED="${required[*]}"

echo "==> G0: expected case counts"
node --input-type=module -e '
import { readFileSync } from "node:fs";
const dir = process.env.SERVANDA_VECTORS ?? "vendor/vectors";
const expected = {
  "canonicalization/jcs.json": 16,
  "hashing/commitment-hash.json": 14,
  "signatures/signatures.json": 5,
  "transitions/valid.json": 9,
  "transitions/invalid.json": 25,
  "addressing/inbox-records.json": 4,
  "addressing/oob-bootstrap.json": 2,
  "node-surface/actions.json": 11,
  "node-surface/act-tool.json": 17,
  "node-surface/brief-slots.json": 7,
  "node-surface/verification-levels.json": 13,
};
let bad = 0;
for (const [file, n] of Object.entries(expected)) {
  const got = JSON.parse(readFileSync(`${dir}/${file}`, "utf8")).cases.length;
  if (got !== n) { console.error(`FAIL: ${file} has ${got} cases, expected ${n}`); bad++; }
  else console.log(`    ${file}: ${got} cases`);
}
const personas = JSON.parse(readFileSync(`${dir}/derivation/persona-keys.json`, "utf8")).personas.length;
if (personas !== 5) { console.error(`FAIL: derivation has ${personas} personas, expected 5`); bad++; }
else console.log(`    derivation/persona-keys.json: ${personas} personas`);
process.exit(bad ? 1 : 0);
'

# PRESENCE IS NOT REPLAY. The two checks above prove a family is on disk and has the case count
# the spec says; neither notices that nothing reads it. `addressing/` sat here for days, present
# and counted, replayed by no test — this gate reported green over an oracle nobody consulted.
# So each required file must now be NAMED by at least one test, which is the cheapest thing that
# would have caught it.
echo "==> G0: every vector family is replayed by some test"
node --input-type=module -e '
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const required = process.env.G0_REQUIRED.split(" ").filter(Boolean);
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}
const sources = walk("packages").map((f) => readFileSync(f, "utf8")).join("\n");
let bad = 0;
for (const file of required) {
  if (sources.includes(file)) console.log(`    ${file}: replayed`);
  else { console.error(`FAIL: ${file} is present and counted, and no test names it`); bad++; }
}
process.exit(bad ? 1 : 0);
'

echo "==> G0: typecheck"
npx tsc --noEmit -p packages/crypto/tsconfig.json
npx tsc --noEmit -p packages/types/tsconfig.json

echo "==> G0: vector conformance suite"
npx vitest run packages/crypto/test packages/types/test --reporter=dot

echo
echo "GATE G0: PASS"
