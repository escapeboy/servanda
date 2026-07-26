#!/usr/bin/env bash
# GATE G3 — Integration.
#
# "end-to-end of scenarios.md #1 and #2 against a fixture repo ... both scenarios pass as
#  automated e2e tests." Extended to #3 and #6, then to #4 and #5 — all six now run here.
#
# The unit suites prove each package keeps its own promises. This gate proves the SEAMS hold:
# a sentence somebody said reaches a brief, and a repository nobody has spoken to produces one.
# Writing it is what surfaced the missing archaeology ingest path — two green streams with an
# empty seam between them.
#
# #3 and #6 are the two scenarios whose claims are negative — that a counterparty who is not on
# the network is never contacted, and that an instruction addressed to the machine reaches
# nothing. A negative claim cannot be proven by a suite that runs whatever it finds, which is
# why every scenario below is named and its absence is a failure.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> G3: fixture repository"
if [ ! -d fixtures/archaeology-repo/repo/.git ]; then
  echo "    materializing the fixture"
  bash fixtures/archaeology-repo/setup.sh >/dev/null
fi
HEAD_SHA=$(git -C fixtures/archaeology-repo/repo rev-parse HEAD)
PINNED=8779acbf1753fc5ddf67a3ae76434880d171a710
if [ "${HEAD_SHA}" != "${PINNED}" ]; then
  echo "FAIL: fixture HEAD ${HEAD_SHA} != pinned ${PINNED}" >&2
  exit 1
fi
echo "    fixtures/archaeology-repo/repo at ${HEAD_SHA}"

echo "==> G3: build"
pnpm -r run build >/dev/null

echo "==> G3: every scenario must be present"
# A gate that runs whatever tests happen to exist cannot fail by omission. Name them.
for f in \
  packages/e2e/test/scenario-1-solo-cycle.test.ts \
  packages/e2e/test/scenario-2-cold-start.test.ts \
  packages/e2e/test/scenario-3-expectation.test.ts \
  packages/e2e/test/scenario-4-team.test.ts \
  packages/e2e/test/scenario-5-cross-org.test.ts \
  packages/e2e/test/scenario-6-attack.test.ts
do
  if [ ! -f "${f}" ]; then
    echo "FAIL: missing scenario test ${f}" >&2
    exit 1
  fi
  echo "    ${f}"
done

echo "==> G3/1: scenario 1 — a spoken sentence reaches a brief"
npx vitest run packages/e2e/test/scenario-1-solo-cycle.test.ts --reporter=dot

echo "==> G3/2: scenario 2 — cold start, archaeology brief within one run"
npx vitest run packages/e2e/test/scenario-2-cold-start.test.ts --reporter=dot

echo "==> G3/3: scenario 3 — expectation, half-network, nothing ever sent to the counterparty"
npx vitest run packages/e2e/test/scenario-3-expectation.test.ts --reporter=dot

echo "==> G3/4: scenario 4 — team, three vaults over one git repository, no network"
npx vitest run packages/e2e/test/scenario-4-team.test.ts --reporter=dot

echo "==> G3/5: scenario 5 — cross-org, domain anchor, and a hash that outlives the terms"
npx vitest run packages/e2e/test/scenario-5-cross-org.test.ts --reporter=dot

echo "==> G3/6: scenario 6 — the attack that did not happen"
npx vitest run packages/e2e/test/scenario-6-attack.test.ts --reporter=dot

echo "==> G3: the scenario suite survives the M-suite filter"
# CI runs the constitution suite as \`vitest -t 'M-'\`, which executes M-named tests and skips
# their siblings. A scenario that assembles state in one \`it\` and reads it in another passes the
# full run and fails here. It has happened once; this is the check that catches it next time.
npx vitest run packages/e2e -t 'M-' --reporter=dot

echo "==> G3: the fixture was not modified by the scenarios"
# Executors touch only fixture repos — and even then they emit a diff rather than mutate a tree.
AFTER=$(git -C fixtures/archaeology-repo/repo rev-parse HEAD)
DIRTY=$(git -C fixtures/archaeology-repo/repo status --porcelain)
if [ "${AFTER}" != "${PINNED}" ] || [ -n "${DIRTY}" ]; then
  echo "FAIL: the scenarios mutated the fixture repository" >&2
  git -C fixtures/archaeology-repo/repo status --short >&2
  exit 1
fi
echo "    fixtures/archaeology-repo/repo is unchanged"

echo
echo "GATE G3: PASS"
