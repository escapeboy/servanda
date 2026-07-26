#!/usr/bin/env bash
# GATE GD — Executors.
#
# "Done" means all four of:
#   1. an executor demonstrably cannot reach the network or CI secrets — proved in the real
#      sandbox, with positive controls showing the trap is armed and negative controls showing
#      the denial is the trap's rather than an absent network or an unset variable;
#   2. a valid DRAFT PR artifact is produced against the fixture repo, changing only what the
#      executor's class permits, and leaving the fixture byte-identical;
#   3. the trust gradient promotes on unedited approvals, collapses asymmetrically on a single
#      correction, and cannot be pushed past a per-class ceiling by any amount of history;
#   4. M-13 and M-8 have named behavioural tests here, and §8 still reports 16/16 overall.
#
# A stage is done only when its gate passes. This script is the definition of done for GD.
set -euo pipefail

cd "$(dirname "$0")/.."

PKG=packages/executors
FIXTURE=fixtures/archaeology-repo/repo
FIXTURE_HEAD=8779acbf1753fc5ddf67a3ae76434880d171a710

echo "==> GD: fixture is present and at the pinned commit"
if [ ! -d "${FIXTURE}" ]; then
  echo "    materialising the fixture"
  bash fixtures/archaeology-repo/setup.sh
fi
head="$(git -C "${FIXTURE}" rev-parse HEAD)"
if [ "${head}" != "${FIXTURE_HEAD}" ]; then
  echo "FAIL: fixture HEAD is ${head}, expected ${FIXTURE_HEAD}" >&2
  echo "      (rebuild it: bash fixtures/archaeology-repo/setup.sh --force)" >&2
  exit 1
fi
echo "    ${FIXTURE} at ${FIXTURE_HEAD}"

# The fixture is the oracle for gate GB as well. Executors are supposed to be structurally
# incapable of writing anywhere, so the check at the end is on the whole gate rather than only on
# the tests that thought to look. A dirty tree here means something wrote where nothing may.
if [ -n "$(git -C "${FIXTURE}" status --porcelain)" ]; then
  echo "FAIL: the fixture working tree is dirty before the gate ran" >&2
  git -C "${FIXTURE}" status --porcelain >&2
  exit 1
fi

echo "==> GD: typecheck"
npx tsc --noEmit -p "${PKG}/tsconfig.json"

echo "==> GD: named MUST tests exist"
for f in "${PKG}/test/musts/M-08.test.ts" "${PKG}/test/musts/M-13.test.ts"; do
  if [ ! -f "${f}" ]; then
    echo "FAIL: missing named MUST test ${f}" >&2
    exit 1
  fi
  echo "    ${f}"
done

echo "==> GD: build (the sandbox host runs from dist, never from source)"
npx tsc -b "${PKG}/tsconfig.json"

echo
echo "==> GD/1: an executor cannot reach the network or CI secrets"
node "${PKG}/test/support/prove-sandbox.mjs"

echo
echo "==> GD: full executor suite"
npx vitest run "${PKG}/test" --reporter=dot

echo
echo "==> GD/2: the draft-PR artifact, asserted from the gate itself"
FIXTURE="${FIXTURE}" FIXTURE_HEAD="${FIXTURE_HEAD}" node --input-type=module -e '
const { runExecutor, DraftPrArtifact } = await import("./packages/executors/dist/index.js");
const FIXTURE = process.env.FIXTURE;
const commitment = {
  v: "servanda/0.1", type: "commitment", owner: "a".repeat(64), owed_to: null, due: null,
  conditions: [], created_at: "2026-01-01T00:00:00Z", source: "archaeology", confidence: 0.9,
  commitment_hash: "b".repeat(64),
};
let bad = 0;
const check = (ok, label, detail = "") => {
  console.log(`    ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad++;
};

const outcome = await runExecutor({
  executorClass: "dead-code",
  commitment,
  target: { kind: "symbol", symbol: "FEATURE_LEGACY_IMPORT", path: "src/flags.ts" },
  persona: "a".repeat(64),
  repo: { path: FIXTURE },
  now: "2026-07-26T10:00:00Z",
});
check(outcome.kind === "artifact", "an artifact was produced", outcome.kind);
if (outcome.kind === "artifact") {
  const a = outcome.artifact;
  check(DraftPrArtifact.safeParse(a).success, "the artifact validates against its schema");
  check(a.draft === true, "it is a draft");
  check(a.signed_by === null, "it is unsigned (M-13)");
  check(a.branch === "servanda/dead-code/bbbbbbbbbbbb", "it names a branch", a.branch);
  check(a.base.base_commit === process.env.FIXTURE_HEAD, "it is based on the pinned commit", a.base.base_commit);
  check(a.changes.length === 1 && a.changes[0].path === "src/flags.ts",
    "it changed exactly one file, inside the class capability", JSON.stringify(a.changes.map(c => c.path)));
  check(a.changes.every(c => a.capabilities.write.some(g =>
    new RegExp("^" + g.split("**").map(s => s.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(c.path))),
    "every change is inside the write capability");
  check(a.diff.includes("-export const FEATURE_LEGACY_IMPORT = false;"), "the diff removes the dead flag");
  // The live flag appears as a CONTEXT line, which is right — it must not appear as a removal.
  check(!a.diff.includes("-export const FEATURE_NEW_CHECKOUT"), "the diff leaves the live flag alone");
}

// The class that has no business in the fixture must produce nothing rather than something.
const none = await runExecutor({
  executorClass: "dep-bump", commitment,
  target: { kind: "dependency", name: "zod", toVersion: "3.25.76" },
  persona: "a".repeat(64), repo: { path: FIXTURE }, now: "2026-07-26T10:00:00Z",
});
check(none.kind === "nothing-to-do", "dep-bump finds nothing to do on a repo with no manifest", none.kind);

// Scenario 6, at the gate: the injected "add a GitHub Actions workflow" has no class to run in.
let refused = false;
try { await runExecutor({ executorClass: "workflow", commitment, target: { kind: "source-file", path: "src/clean.ts" }, persona: "a".repeat(64), repo: { path: FIXTURE } }); }
catch (err) { refused = /not extensible at runtime/.test(String(err)); }
check(refused, "there is no executor class for an injected workflow request (scenario 6)");

process.exit(bad ? 1 : 0);
'

echo
echo "==> GD/3: the trust gradient, asserted from the gate itself"
node --input-type=module -e '
const { applyOutcome, ceilingFor, effectiveAutonomy, emptyTrustRecord, levelFromHistory, getExecutorClass } =
  await import("./packages/executors/dist/index.js");
const NOW = "2026-07-26T10:00:00Z";
const P = "a".repeat(64);
let bad = 0;
const check = (ok, label, detail = "") => {
  console.log(`    ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad++;
};
const run = (rec, kinds) => kinds.reduce((r, kind) => applyOutcome(r, { kind }, NOW), rec);

// Promotion on unedited approvals.
const three = run(emptyTrustRecord(P, "tests", NOW), Array(3).fill("approved"));
const six = run(emptyTrustRecord(P, "tests", NOW), Array(6).fill("approved"));
check(levelFromHistory(emptyTrustRecord(P, "tests", NOW)) === "draft-for-review", "a new class starts at the floor");
check(levelFromHistory(three) === "auto-apply-with-window", "three unedited approvals reach the window");
check(levelFromHistory(six) === "silent-with-receipt", "six reach silent");

// Demotion, and the asymmetry.
const corrected = run(six, ["corrected"]);
check(levelFromHistory(corrected) === "draft-for-review", "one correction collapses to the floor");
const regained = run(corrected, Array(5).fill("approved"));
check(levelFromHistory(regained) !== "silent-with-receipt",
  "five approvals do not undo one correction — collapse is asymmetric", levelFromHistory(regained));

// Scenario 6: the patient attacker, fifty flawless artifacts.
const flawless = run(emptyTrustRecord(P, "dep-bump", NOW), Array(50).fill("approved"));
const ceiling = ceilingFor(getExecutorClass("dep-bump").riskClass);
const decision = effectiveAutonomy({ record: flawless, ceiling, edgeVerifiable: true });
check(flawless.streak === 50, "fifty flawless artifacts, no corrections", String(flawless.streak));
check(decision.earned === "silent-with-receipt", "history alone would have granted silent");
check(decision.level !== "silent-with-receipt", "the ceiling holds it below silent", decision.level);
check(decision.cappedBy === "ceiling", "and says so");

// A ceiling on the blast radius, not just the class name (scenario 6: CI config).
const ci = effectiveAutonomy({ record: flawless, ceiling: ceilingFor("routine", [".github/workflows/ci.yml"]), edgeVerifiable: true });
check(ci.level === "draft-for-review", "anything touching CI config stays a draft regardless of history", ci.level);

// M-8: an unverifiable edge never auto-escalates.
const unverifiable = effectiveAutonomy({ record: six, ceiling: "silent-with-receipt", edgeVerifiable: null });
check(unverifiable.level === "draft-for-review" && unverifiable.cappedBy === "unverifiable-edge",
  "an unverifiable edge never auto-escalates (M-8)", unverifiable.level);

process.exit(bad ? 1 : 0);
'

echo
echo "==> GD/4: MUST coverage across the repository is still complete"
bash gates/must-coverage.sh

echo
echo "==> GD: the fixture was not modified by anything above"
dirty="$(git -C "${FIXTURE}" status --porcelain)"
if [ -n "${dirty}" ]; then
  echo "FAIL: the fixture working tree changed during this gate" >&2
  echo "      an executor is not permitted to write anywhere — it returns an artifact" >&2
  echo "${dirty}" >&2
  exit 1
fi
echo "    ${FIXTURE} is unchanged"

echo
echo "GATE GD: PASS"
