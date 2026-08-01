#!/usr/bin/env bash
# GATE GJ — Verification adapters.
#
# §4.4 says an `on-evidence` closure is "a `closed` assertion by the owner with non-null
# `evidence_hash` (hash of the verification adapter's evidence bundle)", and M-8 says
# "unverifiable edges (no adapter, or invalid collective) MUST NOT auto-escalate". Both
# sentences presuppose a verification adapter. This gate is the definition of done for the
# layer that makes them true rather than aspirational.
#
# "Done" means all five of:
#   1. an evidence bundle hashes reproducibly across two separate processes, and that hash is
#      exactly what a §4.2 assertion carries;
#   2. an `on-evidence` closure works end to end — adapter observes, owner signs, the chain
#      accepts — and the same closure with a NULL evidence_hash is discarded with
#      `evidence-hash-required-for-owner-closure`;
#   3. an unverifiable edge never auto-escalates: proved with an edge no adapter can speak to
#      and with an invalid collective (M-9), and with the positive control that a verifiable
#      overdue edge DOES escalate — a bar that is always false proves nothing;
#   4. nothing reaches the network, proved the GA way: a trap, positive controls that it is
#      armed, a negative control that the denial is the trap's, a static import audit, and —
#      because the git adapter spawns a child the trap cannot cover — a recorded invocation;
#   5. M-8, M-9 and M-13 have named behavioural tests here, and §8 coverage stays complete.
set -euo pipefail

cd "$(dirname "$0")/.."

PKG=packages/adapters
FIXTURE=fixtures/archaeology-repo/repo
FIXTURE_HEAD=8779acbf1753fc5ddf67a3ae76434880d171a710

echo "==> GJ: fixture is present and at the pinned commit"
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

# Adapters observe; they do not act. The check is on the whole gate rather than only on the
# tests that thought to look, so a stray write anywhere in this run is caught.
if [ -n "$(git -C "${FIXTURE}" status --porcelain)" ]; then
  echo "FAIL: the fixture working tree is dirty before the gate ran" >&2
  git -C "${FIXTURE}" status --porcelain >&2
  exit 1
fi

echo "==> GJ: typecheck"
npx tsc --noEmit -p "${PKG}/tsconfig.json"

echo "==> GJ: named MUST tests exist"
for f in "${PKG}/test/musts/M-08.test.ts" "${PKG}/test/musts/M-09.test.ts" "${PKG}/test/musts/M-13.test.ts"; do
  if [ ! -f "${f}" ]; then
    echo "FAIL: missing named MUST test ${f}" >&2
    exit 1
  fi
  echo "    ${f}"
done

echo "==> GJ: build (the gate asserts against dist, never against source)"
npx tsc -b "${PKG}/tsconfig.json"

echo
echo "==> GJ/1: an evidence bundle hashes reproducibly across two separate processes"
OBSERVE='
const A = await import("./packages/adapters/dist/index.js");
const { hashCanonical } = await import("./packages/crypto/dist/index.js");
const commitment = {
  v: "servanda/0.2", type: "commitment", owner: "a".repeat(64), owed_to: "b".repeat(64),
  due: null, conditions: [], created_at: "2026-07-01T09:00:00Z", source: "explicit",
  confidence: 1, commitment_hash: "b".repeat(64),
  evidence_refs: [{ kind: "commit", value: "branch:main" }, { kind: "file", value: "src/flags.ts" }],
};
const outcome = A.verifyCommitment(commitment, {
  now: "2026-07-26T10:00:00Z",
  repo: { path: "fixtures/archaeology-repo/repo" },
  workspace: { root: "fixtures/archaeology-repo/repo" },
});
if (!outcome.verifiable) { console.error("not verifiable: " + outcome.reason); process.exit(1); }
if (outcome.evidence_hash !== hashCanonical(outcome.bundle)) {
  console.error("evidence_hash is not sha256(JCS(bundle))"); process.exit(1);
}
console.log(outcome.evidence_hash);
'
h1="$(node --input-type=module -e "${OBSERVE}")"
h2="$(node --input-type=module -e "${OBSERVE}")"
if [ "${h1}" != "${h2}" ]; then
  echo "FAIL: the same observation hashed two ways: ${h1} vs ${h2}" >&2
  exit 1
fi
if ! printf '%s' "${h1}" | grep -Eq '^[0-9a-f]{64}$'; then
  echo "FAIL: ${h1} is not a sha256 hex digest" >&2
  exit 1
fi
echo "    two processes, one hash: ${h1}"

# The hash is only useful if a §4.2 assertion can carry it verbatim.
EVIDENCE_HASH="${h1}" node --input-type=module -e '
const { Assertion } = await import("./packages/types/dist/index.js");
const a = {
  v: "servanda/0.2", type: "assertion", edge_id: "a".repeat(64), state: "closed",
  asserted_at: "2026-07-26T10:00:00Z", by: "a".repeat(64),
  evidence_hash: process.env.EVIDENCE_HASH, sig: "f".repeat(128),
};
if (!Assertion.safeParse(a).success) { console.error("FAIL: the hash does not fit §4.2"); process.exit(1); }
console.log("    the hash fits the §4.2 assertion evidence_hash field");
'

echo
echo "==> GJ/2 and GJ/3: closure and escalation, asserted from the gate itself"
node --input-type=module -e '
const A = await import("./packages/adapters/dist/index.js");
const N = await import("./packages/node/dist/index.js");
const { commitmentHash, edgeId, withSignature } = await import("./packages/crypto/dist/index.js");

let bad = 0;
const check = (ok, label, detail = "") => {
  console.log(`    ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) bad++;
};

// Real keys: the chain verifies signatures, so fabricated ones would be rejected for the
// wrong reason and the test would prove nothing.
const { derivePersona, mnemonicToSeed } = await import("./packages/crypto/dist/index.js");
const seed = mnemonicToSeed("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art");
const owner = derivePersona(seed, 0);
const owed = derivePersona(seed, 1);

const INTENT = "ship the verification adapters";
const CREATED = "2026-07-01T09:00:00Z";
const DUE = "2026-07-20T00:00:00Z";
const commitment_hash = commitmentHash({ intent: INTENT, owner: owner.personaId, owed_to: owed.personaId, due: DUE, created_at: CREATED });
const edge = (over = {}) => ({
  v: "servanda/0.2", type: "edge",
  edge_id: edgeId({ commitment_hash, owner: owner.personaId, owed_to: owed.personaId, proposed_at: CREATED }),
  commitment_hash, owner: owner.personaId, owed_to: owed.personaId, proposed_at: CREATED,
  due: DUE, closure_policy: "on-evidence", acceptance_window: null, blocked_by: [], supersedes: null,
  ...over,
});
const sign = (edge_id, state, who, asserted_at, evidence_hash) => withSignature({
  v: "servanda/0.2", type: "assertion", edge_id, state, asserted_at, by: who.personaId, evidence_hash,
}, who.privateKey);
const commitment = (refs) => ({
  v: "servanda/0.2", type: "commitment", owner: owner.personaId, owed_to: owed.personaId,
  due: DUE, conditions: [], evidence_refs: refs, created_at: CREATED, source: "explicit",
  confidence: 1, commitment_hash,
});
const CTX = { now: "2026-07-26T10:00:00Z", repo: { path: "fixtures/archaeology-repo/repo" } };
const open = (e) => [
  sign(e.edge_id, "proposed", owner, CREATED, null),
  sign(e.edge_id, "confirmed", owed, "2026-07-01T10:00:00Z", null),
];

// ── GJ/2: on-evidence closure, end to end ───────────────────────────────────────────────
const e = edge();
const outcome = A.verifyCommitment(commitment([{ kind: "commit", value: "branch:main" }]), { ...CTX, edge: e });
check(outcome.verifiable, "an adapter observed the promise", outcome.reason ?? "");
check(outcome.bundle?.satisfied === true, "the observation is satisfied");

const closed = N.verifyAssertionChain(e, [...open(e), sign(e.edge_id, "closed", owner, CTX.now, outcome.evidence_hash)]);
check(closed.outcomes.every((o) => o.accepted), "every assertion in the chain was accepted");
check(closed.final_state === "closed", "the edge closed on the evidence (§4.4)", closed.final_state);

// The negative, with the reason string the vectors already use.
const nulled = N.verifyAssertionChain(e, [...open(e), sign(e.edge_id, "closed", owner, CTX.now, null)]);
check(nulled.final_state === "open", "a null evidence_hash does not close the edge", nulled.final_state);
check(nulled.outcomes[2]?.rejection_reason === "evidence-hash-required-for-owner-closure",
  "and is discarded with the exact reason", String(nulled.outcomes[2]?.rejection_reason));

// A careless caller that ignores `verifiable` gets the same safe answer, not a loud one.
const blind = A.verifyCommitment(commitment([{ kind: "commit", value: "branch:main" }]), { now: CTX.now });
check(blind.verifiable === false && blind.evidence_hash === null,
  "NotVerifiable hands a careless caller a null hash", String(blind.reason));
const careless = N.verifyAssertionChain(e, [...open(e), sign(e.edge_id, "closed", owner, CTX.now, blind.evidence_hash)]);
check(careless.final_state === "open", "so the careless path is the safe path", careless.final_state);

// ── GJ/3: M-8, unverifiable edges never auto-escalate ───────────────────────────────────
const LIVE = new Date("2026-08-01T00:00:00Z");
const verdict = (e, refs) => {
  const chain = N.verifyAssertionChain(e, open(e));
  const outcome = A.verifyCommitment(commitment(refs), { ...CTX, edge: e });
  const nodeVerdict = N.mayAutoEscalate(e, chain, LIVE);
  return { chain, outcome, nodeVerdict, composed: A.mayAutoEscalate({ edge: e, outcome, nodeVerdict }) };
};

const positive = verdict(edge(), [{ kind: "commit", value: "branch:main" }]);
check(positive.composed === true, "an overdue, verifiable on-evidence edge DOES escalate (control)");

const noAdapter = verdict(edge(), [{ kind: "url", value: "https://forge.example/pr/1" }]);
check(noAdapter.outcome.verifiable === false, "no adapter speaks to a url", String(noAdapter.outcome.reason));
check(noAdapter.nodeVerdict === true, "the node alone would have escalated it");
check(noAdapter.composed === false, "an edge no adapter can speak to never auto-escalates (M-8)");

const collective = verdict(edge({ fulfillment: { policy: "all", children: [] } }), [{ kind: "commit", value: "branch:main" }]);
check(collective.chain.unverifiable === true, "an invalid collective is unverifiable (M-9)");
check(collective.outcome.verifiable === false, "and the adapter layer says so before observing", String(collective.outcome.reason));
check(collective.composed === false, "an invalid collective edge never auto-escalates (M-8/M-9)");

const kOfN = verdict(edge({ fulfillment: { policy: "k-of-n", k: 3, children: ["e".repeat(64)] } }), [{ kind: "commit", value: "branch:main" }]);
check(kOfN.composed === false, "nor does a k-of-n decomposition no set of children could satisfy");

const coordinated = verdict(edge({ fulfillment: { policy: "all", children: [], coordinator: owed.personaId } }), [{ kind: "commit", value: "branch:main" }]);
check(coordinated.composed === true, "a named coordinator makes the collective edge verifiable again");

// The on-acceptance side of the interpretation: M-8 must not silence scenario 4.
const acceptance = verdict(edge({ closure_policy: "on-acceptance", acceptance_window: "P5D" }), []);
check(acceptance.outcome.verifiable === false, "an ordinary interpersonal promise has no adapter");
check(acceptance.composed === true, "and still escalates — on-acceptance does not close on evidence (§4.4)");

process.exit(bad ? 1 : 0);
'

echo
echo "==> GJ/4: nothing reaches the network"
node "${PKG}/test/support/prove-no-network.mjs"

echo
echo "==> GJ: full adapter suite"
npx vitest run "${PKG}/test" --reporter=dot

echo
echo "==> GJ/5: MUST coverage across the repository is still complete"
bash gates/must-coverage.sh

echo
echo "==> GJ: the fixture was not modified by anything above"
dirty="$(git -C "${FIXTURE}" status --porcelain)"
if [ -n "${dirty}" ]; then
  echo "FAIL: the fixture working tree changed during this gate" >&2
  echo "      an adapter observes; it never writes" >&2
  echo "${dirty}" >&2
  exit 1
fi
echo "    ${FIXTURE} is unchanged"

echo
echo "GATE GJ: PASS"
