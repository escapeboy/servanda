#!/usr/bin/env bash
# Run every gate that exists, in stage order. A stage is done only when its gate passes.
#
# Gates appear as their stages land. A gate script that is absent is reported as PENDING and
# does not fail the run; a gate script that is present and fails DOES fail the run. Absent and
# passing must never look the same.
set -uo pipefail

cd "$(dirname "$0")/.."

declare -a GATES=(
  "G0:Foundation (types + crypto, vector conformance):gates/g0-vectors.sh"
  "GA:Vault + node (transition table, five tools, M-suite):gates/ga-node.sh"
  "GB:Connectors (deterministic archaeology, envelope validity):gates/gb-connectors.sh"
  "GK:Email (non-technical capture, hostile MIME):gates/gk-email.sh"
  "GC:Extraction (schema-bound, precision harness):gates/gc-extraction.sh"
  "GD:Executors (sandbox containment, draft PR):gates/gd-executors.sh"
  "GJ:Adapters (evidence bundles, unverifiable never escalates):gates/gj-adapters.sh"
  "GF:Federation (two nodes agree offline, blind hub):gates/gf-federation.sh"
  "GG:Identity (ladder, attestation, rotation):gates/gg-identity.sh"
  "GE:Clients (brief latency, keyboard walkthrough, vocabulary):gates/ge-clients.sh"
  "GL:Gestures (in-situ confirm, M-1 uncompilable):gates/gl-gestures.sh"
  "G3:Integration (scenarios 1, 2, 3, 6 end to end):gates/g3-integration.sh"
)

failed=()
passed=()
pending=()

for entry in "${GATES[@]}"; do
  id="${entry%%:*}"
  rest="${entry#*:}"
  desc="${rest%%:*}"
  script="${rest##*:}"

  echo
  echo "──────────────────────────────────────────────────────────────────────"
  echo "  ${id} — ${desc}"
  echo "──────────────────────────────────────────────────────────────────────"

  if [ ! -f "${script}" ]; then
    echo "  PENDING — ${script} does not exist yet"
    pending+=("${id}")
    continue
  fi

  if bash "${script}"; then
    passed+=("${id}")
  else
    echo "  ${id}: FAIL"
    failed+=("${id}")
  fi
done

echo
echo "══════════════════════════════════════════════════════════════════════"
echo "  GATE SUMMARY"
echo "══════════════════════════════════════════════════════════════════════"
[ ${#passed[@]}  -gt 0 ] && echo "  PASS:    ${passed[*]}"
[ ${#pending[@]} -gt 0 ] && echo "  PENDING: ${pending[*]}"
[ ${#failed[@]}  -gt 0 ] && echo "  FAIL:    ${failed[*]}"

if [ ${#failed[@]} -gt 0 ]; then
  exit 1
fi
echo "  no gate failed"
