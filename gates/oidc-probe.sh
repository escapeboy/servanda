#!/usr/bin/env bash
# Can every publishable package publish over OIDC, without a token?
#
# `npm publish` runs the OIDC exchange BEFORE it honours `--dry-run` — in npm's own
# `lib/commands/publish.js`, `await oidc({ packageName, registry, ... })` sits above the dry-run
# branch. So a dry run performs the real token exchange against the real registry for the real
# package name and publishes nothing. npm reports the outcome at verbose level:
#
#     verbose oidc Successfully retrieved and set token
#
# That line is the whole proof, and it is the only one there is. A publish that used OIDC and a
# publish that fell back to a token produce identical output, identical registry metadata, and
# identical provenance attestations — the attestations attest the BUILD, not the credential. That
# is how eighteen configured trusted publishers went unused across two releases while every
# observable signal said the migration had worked.
#
# Two rules make this probe mean something:
#
#   1. NO TOKEN in the environment. With one present the exchange is unnecessary, so a green
#      result would prove nothing about whether OIDC is reachable.
#   2. EVERY package, not a sample. `oidc()` takes a package name and the trust relationship is
#      configured per package, so seventeen working publishers and one missing would be discovered
#      partway through an irreversible loop.
#
# Requires npm >= 11.5.1 (trusted publishing did not exist before it) and a workflow with
# `id-token: write`. Run from the repository root with a directory of packed tarballs.
set -euo pipefail

DIR="${1:?usage: oidc-probe.sh <tarball-dir> [expected-count]}"
EXPECTED="${2:-18}"

if [ -n "${NODE_AUTH_TOKEN:-}" ]; then
  echo "FAIL: NODE_AUTH_TOKEN is set. A probe that can fall back to a token proves nothing." >&2
  exit 1
fi

npm_version="$(npm --version)"
node -e '
  const [have, want] = [process.argv[1], "11.5.1"].map((v) => v.split(".").map(Number));
  if ((have[0] - want[0] || have[1] - want[1] || have[2] - want[2]) < 0) {
    console.error(`FAIL: npm ${process.argv[1]} cannot use trusted publishing; 11.5.1+ is required.`);
    process.exit(1);
  }
' "$npm_version"
echo "==> npm ${npm_version} on node $(node --version)"

shopt -s nullglob
tarballs=("${DIR}"/*.tgz)
if [ "${#tarballs[@]}" -ne "${EXPECTED}" ]; then
  echo "FAIL: expected ${EXPECTED} tarballs in ${DIR}, found ${#tarballs[@]}" >&2
  printf '  %s\n' "${tarballs[@]}" >&2
  exit 1
fi

log="$(mktemp)"
failed=0
for t in "${tarballs[@]}"; do
  name="$(basename "$t")"
  # `--tag latest` explicitly: every version here carries a `-pre` identifier, and npm 11 refuses
  # to publish a prerelease under the default tag. The check fires before the OIDC call, so
  # without this the probe would fail for a reason that has nothing to do with OIDC.
  npm publish "$t" --access public --tag latest --dry-run --loglevel verbose >"$log" 2>&1 || true
  if grep -q 'oidc Successfully retrieved and set token' "$log"; then
    echo "  ok   ${name}"
  else
    echo "  FAIL ${name} — no OIDC token exchange" >&2
    # WHY it failed, not merely that it did. npm reports the cause at verbose under the `oidc`
    # prefix — wrong workflow filename, missing id-token permission, no publisher configured —
    # and a probe that swallowed it would leave the operator with a red tick and no next step.
    # The first version of this script did exactly that, and cost a run to learn nothing.
    grep -E '(^|\s)(verbose|silly|warn|error)\s+oidc\b' "$log" | sed 's/^/         /' >&2 || true
    failed=$((failed + 1))
  fi
done
rm -f "$log"

if [ "${failed}" -gt 0 ]; then
  echo >&2
  echo "FAIL: ${failed}/${#tarballs[@]} package(s) cannot publish over OIDC. Nothing was published." >&2
  exit 1
fi

echo
echo "OIDC PROBE: PASS — all ${#tarballs[@]} packages exchanged a token; nothing was published"
