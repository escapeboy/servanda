#!/usr/bin/env bash
# GATE GA — Vault + node.
#
# "Done" means all three of:
#   1. every negative transition vector rejected with the exact expected reason, and every
#      positive chain accepted with the expected final state;
#   2. the node answers all six §7 MCP tools with networking DISABLED — proved in a child
#      process whose network primitives throw, with controls showing the trap is armed;
#   3. every MUST this layer owns has a named behavioural test here.
#
# A stage is done only when its gate passes. This script is the definition of done for GA.
set -euo pipefail

cd "$(dirname "$0")/.."

VECTORS="${SERVANDA_VECTORS:-vendor/vectors}"

echo "==> GA: transition vectors at ${VECTORS}"
for f in transitions/valid.json transitions/invalid.json; do
  if [ ! -f "${VECTORS}/${f}" ]; then
    echo "FAIL: missing vector file ${VECTORS}/${f}" >&2
    exit 1
  fi
done

# A FLOOR, not an equality.
#
# This was `{valid: 9, invalid: 25}` and the vectors grew past it — `contested-closure` alone
# added seven positive chains and nine refusals — so the gate reported FAIL for a suite that had
# got BIGGER. That is the same defect `gates/must-coverage.sh` records about itself, where a
# hardcoded `length: 16` went on reporting 16/16 while M-20 arrived unchecked: a gate that
# restates a number the source of truth already carries goes stale the first time the truth
# moves, and it fails in whichever direction nobody is watching.
#
# What this check is actually for is a vector file that has been emptied or truncated, because
# `transitions-vectors.test.ts` iterates whatever it finds — zero cases would pass silently, and
# a suite that proves nothing while reporting green is the failure this whole directory exists to
# prevent. A floor catches that and lets the suite grow. It is raised deliberately, never to match
# whatever happens to be there.
node --input-type=module -e '
import { readFileSync } from "node:fs";
const dir = process.env.SERVANDA_VECTORS ?? "vendor/vectors";
const floor = { "transitions/valid.json": 16, "transitions/invalid.json": 34 };
let bad = 0;
for (const [file, min] of Object.entries(floor)) {
  const got = JSON.parse(readFileSync(`${dir}/${file}`, "utf8")).cases.length;
  if (got < min) { console.error(`FAIL: ${file} has ${got} cases, fewer than the floor of ${min}`); bad++; }
  else console.log(`    ${file}: ${got} cases (floor ${min})`);
}
process.exit(bad ? 1 : 0);
'

echo "==> GA: build (typecheck) the two packages"
npx tsc -b packages/vault/tsconfig.json packages/node/tsconfig.json

echo "==> GA/1: transition-table conformance (every vector case, exact reason strings)"
npx vitest run packages/node/test/transitions-vectors.test.ts --reporter=dot

echo
echo "==> GA/2: the node answers all six §7 tools with networking disabled"
node packages/node/test/support/prove-no-network.mjs

echo
echo "==> GA/3: one named test file per MUST"
missing=0
# ENUMERATED, not a range. `seq 1 16` is the same construction that had must-coverage.sh
# reporting 16/16 while M-20 went unchecked: a count cannot notice a MUST it was never told
# about, and §8's ids stopped being contiguous the moment M-17..M-21 landed in the order the
# spec resolved them. The federation MUSTs (M-17, M-18) are listed in gates/gf-federation.sh and
# the envelope one (M-19) in packages/envelope, because placement follows ownership.
for i in 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 20 21; do
  f="packages/node/test/musts/M-${i}.test.ts"
  if [ ! -f "${f}" ]; then
    echo "  FAIL M-${i} ${f} does not exist" >&2
    missing=$((missing + 1))
  else
    echo "  ok   M-${i} ${f}"
  fi
done
if [ "${missing}" -gt 0 ]; then
  echo "FAIL: ${missing} MUST(s) have no test file. §8 is binding on code." >&2
  exit 1
fi

echo
echo "==> GA/3: MUST coverage (every M-x named in a test)"
bash gates/must-coverage.sh

echo
echo "==> GA: full vault + node suites"
npx vitest run packages/vault/test packages/node/test --reporter=dot

echo
echo "GATE GA: PASS"
