#!/usr/bin/env bash
# GATE G3 — Integration.
#
# "end-to-end of scenarios.md #1 and #2 against a fixture repo ... both scenarios pass as
#  automated e2e tests."
#
# The unit suites prove each package keeps its own promises. This gate proves the SEAMS hold:
# a sentence somebody said reaches a brief, and a repository nobody has spoken to produces one.
# Writing it is what surfaced the missing archaeology ingest path — two green streams with an
# empty seam between them.
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

echo "==> G3: both scenarios must be present"
# A gate that runs whatever tests happen to exist cannot fail by omission. Name them.
for f in \
  packages/e2e/test/scenario-1-solo-cycle.test.ts \
  packages/e2e/test/scenario-2-cold-start.test.ts
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
