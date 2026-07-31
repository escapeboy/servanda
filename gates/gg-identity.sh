#!/usr/bin/env bash
# GATE GG — Identity (§1).
#
# "Done" means all five of:
#   1. the §1.6 ladder returns the right level for every evidence combination, including the
#      downgrades: expired attestation, revoked-then-signed edge, anchor that fails to resolve;
#   2. every named forgery fails — attestation signed by a non-org key, rotation with a missing
#      or wrong `sig`, a `link` only one persona signed, an anchor whose `org_root` disagrees
#      with the attestation's `org`;
#   3. the package cannot reach the network — proved with an armed trap, positive controls that
#      trip it, and a negative control showing the denial comes from the trap rather than from
#      an absent network;
#   4. M-12 and M-13 have named behavioural tests in this layer;
#   5. gates/must-coverage.sh still reports every MUST covered.
#
# A stage is done only when its gate passes. This script is the definition of done for GG.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> GG: build (typecheck) @servanda/identity"
npx tsc -b packages/identity/tsconfig.json

echo
echo "==> GG/1: the §1.6 binding-proof ladder, levels and downgrades"
npx vitest run packages/identity/test/ladder.test.ts --reporter=dot

echo
echo "==> GG/1: §1.3 attestation, revocation boundary, §1.5 anchor"
npx vitest run packages/identity/test/attestation.test.ts packages/identity/test/anchor.test.ts --reporter=dot

echo
echo "==> GG/2: forgeries — every one of them must fail"
npx vitest run packages/identity/test/forgery.test.ts --reporter=dot

echo
echo "==> GG/2: §1.7 rotation and §1.6 linking, including the takeover attempts"
npx vitest run packages/identity/test/rotation.test.ts packages/identity/test/link.test.ts --reporter=dot

echo
echo "==> GG/3: the package answers all of §1 with networking DENIED"
node packages/identity/test/support/prove-no-network.mjs

echo
echo "==> GG/4: named MUST tests in the layer that owns them"
missing=0
for m in M-12 M-13; do
  f="packages/identity/test/musts/${m}.test.ts"
  if [ ! -f "${f}" ]; then
    echo "  FAIL ${m} ${f} does not exist" >&2
    missing=$((missing + 1))
  elif ! grep -q "describe('${m}:" "${f}"; then
    echo "  FAIL ${m} ${f} has no describe block naming it" >&2
    missing=$((missing + 1))
  else
    echo "  ok   ${m} ${f}"
  fi
done
if [ "${missing}" -gt 0 ]; then
  echo "FAIL: ${missing} MUST(s) have no named test in packages/identity. §8 is binding on code." >&2
  exit 1
fi
npx vitest run packages/identity/test/musts --reporter=dot

echo
echo "==> GG/5: ADR-0014 recovery, including the designed dead end"
npx vitest run packages/identity/test/recovery.test.ts --reporter=dot

echo
echo "==> GG/5: MUST coverage across the whole repo (every registered MUST has a test)"
bash gates/must-coverage.sh

echo
echo "==> GG: full identity suite"
npx vitest run packages/identity/test --reporter=dot

echo
echo "GATE GG: PASS"
