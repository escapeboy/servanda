#!/usr/bin/env bash
# GATE GK — Email capture.
#
# A stage is done only when its gate passes. This script is the definition of done for
# @servanda/connectors-email, and it asserts five things:
#
#   1. Capture over the fixture mailbox is DETERMINISTIC — same mailbox state, same envelopes,
#      same ids, same order — across two separate PROCESSES.
#   2. The connector never emits anything but a valid §2 envelope, whatever a mailbox contains:
#      header injection, malformed MIME, HTML with scripts, a 10 MB body, invalid UTF-8, an
#      empty message, a spoofed From. Injected text lands inertly in `payload`.
#   3. Sent-mail archaeology finds exactly the planted promises and questions, and says nothing
#      about the messages that are not promises.
#   4. The package cannot reach the network — proved with an armed trap plus controls, the way
#      gates/ga-node.sh does, not asserted.
#   5. The MUSTs this layer owns (M-5, M-6, M-12) have named tests, and whole-repo MUST
#      coverage still stands at 16/16.
set -euo pipefail

cd "$(dirname "$0")/.."

PKG="packages/connectors-email"
FIXTURE="${PKG}/fixtures/mailbox"

echo "==> GK: workspace links"
for dep in @servanda/types @servanda/crypto; do
  if ! node -e "require.resolve('${dep}', { paths: ['${PWD}/${PKG}/src'] })" >/dev/null 2>&1; then
    echo "FAIL: ${dep} is not resolvable from ${PKG} — run 'pnpm install'" >&2
    exit 1
  fi
done
echo "    @servanda/types and @servanda/crypto resolve from ${PKG}"

echo "==> GK: fixture mailbox"
for mailbox in INBOX Sent; do
  if [ ! -d "${FIXTURE}/${mailbox}" ]; then
    echo "FAIL: missing fixture mailbox ${FIXTURE}/${mailbox}" >&2
    exit 1
  fi
done
messages="$(find "${FIXTURE}" -name '*.eml' | wc -l | tr -d ' ')"
if [ "${messages}" != "9" ]; then
  echo "FAIL: fixture mailbox holds ${messages} messages, expected 9" >&2
  exit 1
fi
echo "    ${FIXTURE}: ${messages} messages across INBOX and Sent"

echo "==> GK: typecheck"
npx tsc -b "${PKG}"

# Determinism across PROCESSES, not just across calls in one test. Two fresh node processes
# mine the same fixture mailbox; any hidden clock read, map-iteration order, or filesystem-order
# dependency shows up here and nowhere else.
echo "==> GK/1: cross-process determinism"
mine() { node "${PKG}/test/support/mine.mjs"; }
a="$(mine)"
b="$(mine)"
if [ "${a}" != "${b}" ]; then
  echo "FAIL: two runs over identical mailbox state differ" >&2
  diff <(printf '%s' "${a}") <(printf '%s' "${b}") | head -20 >&2 || true
  exit 1
fi

counts="$(printf '%s' "${a}" | node -e '
let s = "";
process.stdin.on("data", (c) => (s += c)).on("end", () => {
  const o = JSON.parse(s);
  const ids = new Set([...o.capture, ...o.archaeology, ...o.gestures].map((e) => e.id));
  console.log(`${o.capture.length} ${o.archaeology.length} ${o.gestures.length} ${ids.size}`);
});
')"
read -r n_capture n_archaeology n_gestures n_ids <<<"${counts}"
if [ "${n_capture}" != "9" ] || [ "${n_archaeology}" != "4" ] || [ "${n_gestures}" != "2" ]; then
  echo "FAIL: expected 9 capture / 4 archaeology / 2 gesture envelopes, got ${n_capture} / ${n_archaeology} / ${n_gestures}" >&2
  exit 1
fi
echo "    ${n_capture} capture + ${n_archaeology} archaeology + ${n_gestures} gesture envelopes, ${n_ids} distinct ids, byte-identical across two processes"

# The id must be a function of the envelope's own content, so two personas over the same
# mailbox must share nothing. That is the connector-side half of M-5.
echo "==> GK/1: two personas over one mailbox share no envelope id"
node --input-type=module -e '
import { EmailConnector, FixtureImapClient } from "./packages/connectors-email/dist/index.js";
const opts = (persona) => ({ persona, addresses: ["me@pricex.example", "capture@pricex.example"], sentMailboxes: ["Sent"] });
const client = new FixtureImapClient("packages/connectors-email/fixtures/mailbox");
const ctx = { receivedAt: "2026-09-01T00:00:00Z" };
const a = await new EmailConnector(opts("2".repeat(64))).capture(client, ctx);
const b = await new EmailConnector(opts("3".repeat(64))).capture(client, ctx);
const shared = a.map((e) => e.id).filter((id) => b.some((e) => e.id === id));
if (shared.length > 0) {
  console.error(`FAIL: ${shared.length} envelope id(s) shared across personas`);
  process.exit(1);
}
console.log(`    ${a.length} vs ${b.length} envelopes, 0 shared ids`);
'

echo
echo "==> GK/2 + GK/3 + GK/5: the connector suites"
npx vitest run "${PKG}/test" --reporter=dot

# GK/3 asserted from the emitted set rather than only from inside vitest: the two control
# messages in the fixture (an invoice notice, and a reply whose only promise is inside quoted
# text from the other party) must produce NOTHING.
echo "==> GK/3: archaeology controls stay silent"
printf '%s' "${a}" | node -e '
let s = "";
process.stdin.on("data", (c) => (s += c)).on("end", () => {
  const { archaeology } = JSON.parse(s);
  const kinds = ["archaeology_sent_promise", "archaeology_sent_question"];
  let bad = 0;
  for (const e of archaeology) {
    if (!kinds.includes(e.kind)) { console.error(`FAIL: unexpected kind ${e.kind}`); bad++; }
    if (e.payload.mailbox !== "Sent") { console.error(`FAIL: mined ${e.payload.mailbox}, not Sent`); bad++; }
  }
  // uid 2 is the invoice notice; uid 3 is the reply that only quotes someone else’s promise.
  for (const uid of [2, 3]) {
    const hits = archaeology.filter((e) => e.payload.uid === uid);
    if (hits.length > 0) { console.error(`FAIL: control message uid=${uid} produced ${hits.length} envelope(s)`); bad++; }
    else console.log(`    control uid=${uid}: silent`);
  }
  const found = archaeology.map((e) => `${e.kind}#${e.payload.uid}`).join(" ");
  console.log(`    findings: ${found}`);
  process.exit(bad ? 1 : 0);
});
'

echo
echo "==> GK/4: the package cannot reach the network"
node "${PKG}/test/support/prove-no-network.mjs"

# The MUSTs this layer owns. must-coverage.sh is the whole-repo gate; GK asserts its own rows
# from that script's output rather than by re-implementing the check, and then asserts the
# whole-repo total has not regressed.
echo
echo "==> GK/5: named MUST tests for this layer"
for f in "${PKG}/test/musts/M-05.test.ts" "${PKG}/test/musts/M-06.test.ts" "${PKG}/test/musts/M-12.test.ts"; do
  if [ ! -f "${f}" ]; then
    echo "FAIL: missing named MUST test ${f}" >&2
    exit 1
  fi
done

coverage="$(bash gates/must-coverage.sh 2>&1 || true)"
for id in "M-5" "M-6" "M-12"; do
  if ! printf '%s' "${coverage}" | grep -qE "ok +${id}\b"; then
    echo "FAIL: must-coverage does not register ${id}" >&2
    printf '%s\n' "${coverage}" >&2
    exit 1
  fi
  printf '    %s\n' "$(printf '%s' "${coverage}" | grep -E "ok +${id}\b")"
done

if ! printf '%s' "${coverage}" | grep -q "16/16 MUSTs covered"; then
  echo "FAIL: whole-repo MUST coverage is not 16/16" >&2
  printf '%s\n' "${coverage}" >&2
  exit 1
fi
printf '    %s\n' "$(printf '%s' "${coverage}" | grep '16/16')"

echo
echo "GATE GK: PASS"
