#!/usr/bin/env bash
# GATE GF — Federation (L2): §6 transports, blind courier, reconciliation, edge recovery.
#
# "Done" means all five of:
#   1. two nodes reach agreement over a transport with NO network — two vaults, two clones, one
#      local bare repository, proved in a child process whose network primitives throw, with
#      positive controls showing the trap is armed and a negative control showing the denial
#      came from the trap rather than from an absent network;
#   2. a hub learns nothing — the hub-visible envelope carries exactly the §6.3 fields, and
#      neither plaintext nor sender is derivable from the whole of what a hub holds;
#   3. invalid assertions arriving over the wire are discarded (M-14), using the same 19
#      negative vectors the node gate uses, delivered as wire messages;
#   4. a §6.6 recovery response carries no plaintext (M-7);
#   5. every MUST this layer owns has a named test, and repo-wide coverage stays at 16/16.
#
# A stage is done only when its gate passes. This script is the definition of done for GF.
set -euo pipefail

cd "$(dirname "$0")/.."

VECTORS="${SERVANDA_VECTORS:-vendor/vectors}"

echo "==> GF: the conformance oracle is present"
if [ ! -f "${VECTORS}/transitions/invalid.json" ]; then
  echo "FAIL: missing vector file ${VECTORS}/transitions/invalid.json" >&2
  exit 1
fi
node --input-type=module -e '
import { readFileSync } from "node:fs";
const dir = process.env.SERVANDA_VECTORS ?? "vendor/vectors";
const got = JSON.parse(readFileSync(`${dir}/transitions/invalid.json`, "utf8")).cases.length;
if (got !== 19) { console.error(`FAIL: transitions/invalid.json has ${got} cases, expected 19`); process.exit(1); }
console.log(`    transitions/invalid.json: ${got} cases (reused as wire input)`);
'

echo
echo "==> GF: build (typecheck) the federation package and everything it stands on"
npx tsc -b packages/federation/tsconfig.json

echo
echo "==> GF/1: two nodes reach agreement over a transport with no network"
node packages/federation/test/support/prove-no-network.mjs

echo
echo "==> GF/2 + GF/4: a hub learns nothing; a recovery response carries no plaintext"
npx vitest run packages/federation/test/musts/M-07.test.ts packages/federation/test/musts/M-11.test.ts --reporter=dot

echo
echo "==> GF/3: invalid assertions arriving over the wire are discarded (M-14)"
npx vitest run packages/federation/test/musts/M-14.test.ts --reporter=dot

echo
echo "==> GF/5: one named test file per MUST this layer owns"
missing=0
for i in 02 04 07 11 14; do
  f="packages/federation/test/musts/M-${i}.test.ts"
  if [ ! -f "${f}" ]; then
    echo "  FAIL M-${i} ${f} does not exist" >&2
    missing=$((missing + 1))
  else
    echo "  ok   M-${i} ${f}"
  fi
done
if [ "${missing}" -gt 0 ]; then
  echo "FAIL: ${missing} MUST(s) this layer owns have no test file. §8 is binding on code." >&2
  exit 1
fi

echo
echo "==> GF/5: MUST coverage across the repository (must stay 16/16)"
bash gates/must-coverage.sh

echo
echo "==> GF: full federation suite"
npx vitest run packages/federation/test --reporter=dot

echo
echo "GATE GF: PASS"
