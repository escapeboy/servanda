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
required=(
  canonicalization/jcs.json
  hashing/commitment-hash.json
  signatures/signatures.json
  derivation/persona-keys.json
  transitions/valid.json
  transitions/invalid.json
)
for f in "${required[@]}"; do
  if [ ! -f "${VECTORS}/${f}" ]; then
    echo "FAIL: missing vector file ${VECTORS}/${f}" >&2
    exit 1
  fi
done
echo "    all ${#required[@]} vector files present"

echo "==> G0: expected case counts"
node --input-type=module -e '
import { readFileSync } from "node:fs";
const dir = process.env.SERVANDA_VECTORS ?? "vendor/vectors";
const expected = {
  "canonicalization/jcs.json": 16,
  "hashing/commitment-hash.json": 14,
  "signatures/signatures.json": 5,
  "transitions/valid.json": 7,
  "transitions/invalid.json": 19,
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

echo "==> G0: typecheck"
npx tsc --noEmit -p packages/crypto/tsconfig.json
npx tsc --noEmit -p packages/types/tsconfig.json

echo "==> G0: vector conformance suite"
npx vitest run packages/crypto/test packages/types/test --reporter=dot

echo
echo "GATE G0: PASS"
