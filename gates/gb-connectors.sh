#!/usr/bin/env bash
# GATE GB — Connectors.
#
# A stage is done only when its gate passes. This script is the definition of done for the
# connector layer, and it asserts three things:
#
#   1. Archaeology over the fixture is DETERMINISTIC — same repo state, same envelopes, same
#      ids, same order — and finds exactly the planted findings while leaving the controls
#      silent.
#   2. A connector never emits anything but a valid §2 envelope, whatever it is fed.
#   3. The MUSTs this layer owns (M-5, M-6) have named tests that must-coverage registers.
set -euo pipefail

cd "$(dirname "$0")/.."

FIXTURE_DIR="fixtures/archaeology-repo"
FIXTURE_REPO="${FIXTURE_DIR}/repo"
# Pinned in fixtures/archaeology-repo/EXPECTED.md. Reproducibility of the generator, not
# just "it ran here once", is what this constant buys.
FIXTURE_HEAD="8779acbf1753fc5ddf67a3ae76434880d171a710"

PKGS=(packages/connectors-claude-code packages/connectors-github)

echo "==> GB: workspace links"
for pkg in "${PKGS[@]}"; do
  if ! node -e "require.resolve('@servanda/types', { paths: ['${PWD}/${pkg}/src'] })" >/dev/null 2>&1; then
    echo "FAIL: @servanda/types is not resolvable from ${pkg} — run 'pnpm install'" >&2
    exit 1
  fi
done
echo "    @servanda/types and @servanda/crypto resolve from both connector packages"

echo "==> GB: archaeology fixture"
bash "${FIXTURE_DIR}/setup.sh" >/dev/null
head="$(git -C "${FIXTURE_REPO}" rev-parse HEAD)"
if [ "${head}" != "${FIXTURE_HEAD}" ]; then
  echo "FAIL: fixture HEAD ${head}, expected ${FIXTURE_HEAD}" >&2
  echo "      the generator is not reproducing the pinned repository — see ${FIXTURE_DIR}/EXPECTED.md" >&2
  exit 1
fi
echo "    ${FIXTURE_REPO} at ${head}"

echo "==> GB: typecheck"
npx tsc -b packages/connectors-claude-code packages/connectors-github

# Determinism across PROCESSES, not just across calls in one test. Two fresh node processes
# mine the same fixture; any hidden clock read, map-iteration order, or filesystem-order
# dependency shows up here and nowhere else.
echo "==> GB: cross-process determinism"
mine() {
  node --input-type=module -e '
import { GithubConnector } from "./packages/connectors-github/dist/index.js";
const envelopes = new GithubConnector({ persona: "a".repeat(64) }).archaeology({
  repoPath: "fixtures/archaeology-repo/repo",
  receivedAt: "2026-01-01T00:00:00Z",
  referenceTime: "2026-01-01T00:00:00Z",
});
process.stdout.write(JSON.stringify(envelopes));
'
}
a="$(mine)"
b="$(mine)"
if [ "${a}" != "${b}" ]; then
  echo "FAIL: two runs of archaeology over identical fixture state differ" >&2
  diff <(printf '%s' "${a}") <(printf '%s' "${b}") | head -20 >&2 || true
  exit 1
fi
count="$(printf '%s' "${a}" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).length))')"
if [ "${count}" != "6" ]; then
  echo "FAIL: expected 6 findings from the fixture, got ${count} — see ${FIXTURE_DIR}/EXPECTED.md" >&2
  exit 1
fi
echo "    ${count} findings, byte-identical across two processes"

echo "==> GB: connector suites"
npx vitest run packages/connectors-claude-code/test packages/connectors-github/test --reporter=dot

# The MUSTs this layer owns. must-coverage.sh is the whole-repo gate and will fail while
# other layers are unwritten, so GB asserts only its own rows — and asserts them from that
# script's output rather than by re-implementing the check.
echo "==> GB: named MUST tests for this layer"
for f in \
  packages/connectors-claude-code/test/musts/M-05.test.ts \
  packages/connectors-claude-code/test/musts/M-06.test.ts \
  packages/connectors-github/test/musts/M-05.test.ts \
  packages/connectors-github/test/musts/M-06.test.ts; do
  if [ ! -f "${f}" ]; then
    echo "FAIL: missing named MUST test ${f}" >&2
    exit 1
  fi
done

coverage="$(bash gates/must-coverage.sh 2>&1 || true)"
for id in "M-5" "M-6"; do
  if ! printf '%s' "${coverage}" | grep -qE "ok +${id}\b"; then
    echo "FAIL: must-coverage does not register ${id}" >&2
    printf '%s\n' "${coverage}" >&2
    exit 1
  fi
  printf '    %s\n' "$(printf '%s' "${coverage}" | grep -E "ok +${id}\b")"
done

echo
echo "GATE GB: PASS"
