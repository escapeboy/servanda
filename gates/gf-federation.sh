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
#   3. invalid assertions arriving over the wire are discarded (M-14), using the same 23
#      negative vectors the node gate uses, delivered as wire messages;
#   4. a §6.6 recovery response carries no plaintext (M-7);
#   5. every MUST this layer owns has a named test, and repo-wide coverage stays complete.
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
// A SECOND copy of the count gates/g0-vectors.sh already pins, and it went stale when the family
// grew from 19 to 21 — g0 was updated, this was not, and GF failed for a reason that had nothing
// to do with federation. The count is still pinned rather than counted, because a family that
// silently SHRINKS is the failure the oracle exists to catch; the two numbers just have to move
// together.
if (got !== 23) { console.error(`FAIL: transitions/invalid.json has ${got} cases, expected 23`); process.exit(1); }
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
for i in 02 04 07 11 14 17 18; do
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

# M-18 asserted on the SHIPPED module, not on the source a test can read. A courtesy renderer
# that could sign would be a party able to manufacture confirmations for people who have no node
# — the concentration §6.7 built it to avoid — so "it holds no keys" is checked the way GF checks
# "it reaches no network": by scanning what actually ships, with a control proving the scan fires.
echo
echo "==> GF/6: M-18 — the shipped courtesy renderer cannot sign"
node --input-type=module -e '
import { readFileSync } from "node:fs";
const FILE = "packages/federation/dist/bootstrap.js";
const FORBIDDEN = [/\bsignObject\b/, /\bwithSignature\b/, /\bsignMessage\b/, /\bprivateKey\b/, /getPublicKey/];
const text = readFileSync(FILE, "utf8");
const hits = FORBIDDEN.filter((re) => re.test(text));
if (hits.length > 0) {
  console.error(`FAIL: ${FILE} references a signing primitive: ${hits.join(", ")}`);
  process.exit(1);
}
if (!FORBIDDEN.some((re) => re.test("withSignature(o, k)"))) {
  console.error("FAIL: the scanner does not detect a known violation");
  process.exit(1);
}
console.log(`    ${FILE}: 0 signing primitives, scanner verified against a known violation`);
'

# §6.3, on the SHIPPED module. A persona now has its own X25519 key, so nothing in the sealing
# path may convert a signing key into one — that is what makes upstream #7 unreachable here
# rather than merely compensated for. The unit suite asserts the same over source, because gate
# G0 runs it without building; this is the half that sees what actually ships.
echo "==> GF/6: §6.3 — the shipped sealing module cannot convert a signing key"
node --input-type=module -e '
import { readFileSync } from "node:fs";
const FILE = "packages/crypto/dist/transport.js";
const FORBIDDEN = [/edwardsToMontgomeryPub/, /edwardsToMontgomeryPriv/];
const text = readFileSync(FILE, "utf8");
const hits = FORBIDDEN.filter((re) => re.test(text));
if (hits.length > 0) {
  console.error(`FAIL: ${FILE} still reaches for the birational map: ${hits.join(", ")}`);
  process.exit(1);
}
if (!FORBIDDEN.some((re) => re.test("edwardsToMontgomeryPub(x)"))) {
  console.error("FAIL: the scanner does not detect a known violation");
  process.exit(1);
}
console.log(`    ${FILE}: 0 birational-map conversions, scanner verified against a known violation`);
'

echo
echo "==> GF/5: MUST coverage across the repository (every registered MUST has a test)"
bash gates/must-coverage.sh

echo
echo "==> GF: full federation suite"
npx vitest run packages/federation/test --reporter=dot

echo
echo "GATE GF: PASS"
