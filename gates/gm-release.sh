#!/usr/bin/env bash
# GATE GM — Release: the published build is the one you build.
#
# The failure this exists for, in the form it actually happened:
#
#   Every tag through v0.4.0-pre carried `ARGON2ID_PARAMS = {m: 65536, t: 3, p: 1}`. The raise to
#   the desktop point (m = 1 GiB, 16× the memory) landed in the commit AFTER v0.4.0-pre, and the
#   workspace version did not move. So `npm install @servanda/node` gave a build that made vaults
#   at the floor, `git clone` gave a build that made them at 1 GiB, both called themselves
#   0.4.0-pre, and a wrap is opened at the profile it was WRITTEN at — the weaker vaults stay
#   weaker for life. Nothing failed. Nothing said anything.
#
# No bundler, no conditional export, no env-gated constant was involved, and looking for one is
# how an afternoon gets spent. The mechanism is that a version string is not required to move when
# the meaning of the artifact it names does, and the release workflow's `version:` job checks only
# that the tag and the manifests agree WITH EACH OTHER.
#
# Two checks, because there are two ways to ship this and they are not the same way:
#
#   1. The version must not already name a different published artifact.
#   2. The PACKED artifact — the bytes npm would receive — must make vaults at the profile this
#      repository claims. Asserted by making one and opening it, not by reading a constant: a
#      build that RECORDS the desktop profile while DERIVING at the floor reads correctly and
#      fails to open.
#
# Check 2 costs two real Argon2id derivations at m = 1 GiB, about fifty seconds. That is the price
# of the only measurement that cannot be fooled by how the divergence was introduced.
set -euo pipefail

cd "$(dirname "$0")/.."

fail() { echo "FAIL: $*" >&2; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
# 1. The version names this tree, and not one that has already shipped.
# ─────────────────────────────────────────────────────────────────────────────
version=$(node -p "require('./package.json').version")
echo "==> GM: workspace version ${version}"

if git rev-parse -q --verify "refs/tags/v${version}" >/dev/null; then
  # The tag exists. That is fine when this tree IS that release — checking out a tag must not fail
  # its own gate — and is the reported defect when the tree has moved on without the version.
  #
  # Scoped to `packages/`: docs, gates and CI move between releases without changing a byte of what
  # npm receives, and failing on those would train people to ignore this.
  if git diff --quiet "v${version}" HEAD -- packages 2>/dev/null; then
    echo "    v${version} is tagged and packages/ is identical to it"
  else
    changed=$(git diff --name-only "v${version}" HEAD -- packages | wc -l | tr -d ' ')
    echo "    packages/ differs from tag v${version} in ${changed} file(s):" >&2
    git diff --stat "v${version}" HEAD -- packages | tail -20 >&2
    fail "the manifests say ${version}, which is already tagged, and ${changed} file(s) under packages/ have changed since.
      A published ${version} and this tree are then two different artifacts under one name, which is
      exactly how the Argon2id default shipped at the floor while the source read 1 GiB.
      Bump the version in every packages/*/package.json and in the workspace root, and say what
      changed in CHANGELOG.md."
  fi
else
  echo "    v${version} is not tagged yet — this version has not shipped"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. What the tarball actually does.
# ─────────────────────────────────────────────────────────────────────────────
tmp=$(mktemp -d -t servanda-gm-XXXXXX)
trap 'rm -rf "${tmp}"' EXIT

echo "==> GM: packing the artifact the release would publish"
# The same `pnpm pack` release.yml uses, so this reads the same bytes: `files: ["dist"]` decides
# what is inside, and pnpm is what rewrites `workspace:*` to a real version.
pnpm --filter ./packages/types --filter ./packages/crypto --filter ./packages/vault \
  pack --pack-destination "${tmp}/tarballs" >/dev/null

mkdir -p "${tmp}/node_modules/@servanda"
count=0
for tgz in "${tmp}"/tarballs/*.tgz; do
  name=$(basename "${tgz}" | sed -E "s/^servanda-(.+)-${version}\.tgz$/\1/")
  mkdir -p "${tmp}/node_modules/@servanda/${name}"
  tar xzf "${tgz}" -C "${tmp}/node_modules/@servanda/${name}" --strip-components=1
  count=$((count + 1))
done
[ "${count}" -eq 3 ] || fail "expected 3 tarballs, packed ${count}"
echo "    unpacked ${count} tarballs into a tree with no source in it"

# Third-party dependencies are symlinked from the workspace install rather than fetched: what is
# under test is OUR packed code, and a gate that needs the network is a gate people skip.
for dep in @noble @scure zod; do
  for src in packages/crypto/node_modules packages/vault/node_modules node_modules; do
    if [ -e "${src}/${dep}" ]; then
      ln -sfn "$(cd "${src}/${dep}" && pwd -P)" "${tmp}/node_modules/${dep}"
      break
    fi
  done
  [ -e "${tmp}/node_modules/${dep}" ] || fail "cannot find ${dep} to link; run pnpm install"
done

# `dist` only — if a tarball ever ships `src`, the import below would resolve to source and this
# gate would quietly stop testing the artifact.
for pkg in types crypto vault; do
  [ -d "${tmp}/node_modules/@servanda/${pkg}/dist" ] || fail "@servanda/${pkg} tarball has no dist/"
  [ ! -d "${tmp}/node_modules/@servanda/${pkg}/src" ] || fail "@servanda/${pkg} tarball ships src/"
done

echo "==> GM: making a vault with the packed build (two Argon2id derivations, ~50s)"
cat >"${tmp}/probe.mjs" <<'PROBE'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARGON2ID_DESKTOP, ARGON2ID_PARAMS } from '@servanda/crypto';
import { Vault } from '@servanda/vault';

// Read from the PACKED module, not from source: if the artifact's default is the floor, this is
// the value that is the floor.
if (ARGON2ID_PARAMS.m !== ARGON2ID_DESKTOP.m || ARGON2ID_PARAMS.t !== ARGON2ID_DESKTOP.t) {
  throw new Error(
    `the packed build's default profile is m=${ARGON2ID_PARAMS.m} t=${ARGON2ID_PARAMS.t} p=${ARGON2ID_PARAMS.p}, ` +
      `not the desktop point m=${ARGON2ID_DESKTOP.m} t=${ARGON2ID_DESKTOP.t} p=${ARGON2ID_DESKTOP.p}`,
  );
}

const dir = mkdtempSync(join(tmpdir(), 'servanda-gm-vault-'));
try {
  // No `kdf` option — the default path, which is the one every published CLI takes.
  Vault.create({ dir, passphrase: 'a passphrase for the release gate' });

  const wrap = JSON.parse(readFileSync(join(dir, 'keyset.json'), 'utf8')).wraps
    .find((w) => w.kind === 'passphrase');
  if (!wrap?.kdf) throw new Error('the packed build wrote a keyset with no passphrase wrap');
  const recorded = `m=${wrap.kdf.m} t=${wrap.kdf.t} p=${wrap.kdf.p}`;
  const wanted = `m=${ARGON2ID_DESKTOP.m} t=${ARGON2ID_DESKTOP.t} p=${ARGON2ID_DESKTOP.p}`;
  if (recorded !== wanted) throw new Error(`a default vault records ${recorded}, not ${wanted}`);

  // The check a recorded number cannot pass on its own. Opening derives with the parameters in the
  // file; it succeeds only if those are the parameters that were spent when the wrap was made.
  const reopened = Vault.open({ dir, passphrase: 'a passphrase for the release gate' });
  const profile = reopened.kdfProfile();
  if (profile === null || profile.behindDefault) {
    throw new Error(`the packed build reports its own fresh vault as behind default: ${JSON.stringify(profile)}`);
  }
  console.log(`    a default vault is ${wanted}, and opens at those parameters`);
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
PROBE

node "${tmp}/probe.mjs" || fail "the packed artifact does not make vaults at the profile this repository claims"

# ─────────────────────────────────────────────────────────────────────────────
# 3. The way OUT of a weak vault, end to end.
# ─────────────────────────────────────────────────────────────────────────────
#
# Every vault a published build made is at the floor for life unless somebody re-wraps it, so the
# escape has to work, and here is the only place it can be proved: a re-wrap costs one Argon2id at
# m = 1 GiB, and a twenty-four-second synchronous call inside a vitest worker stops it answering
# the reporter's RPC — ten cases passed and the RUN exited 1 with `Timeout calling "onTaskUpdate"`.
# That is why every vault in the suite is at `ARGON2ID_CONSTRAINED`, and why no test can observe
# what the DEFAULT profile actually costs. A plain node process has no such clock.
#
# Against `dist` rather than the tarball: what section 2 checks is the packed artifact, and what
# this checks is that the path exists at all. Packing @servanda/node would drag its whole
# dependency tree in for no additional claim.
echo "==> GM: raising a floor vault with the built bin (~50s)"
weak="${tmp}/weak-vault"
passphrase='a passphrase for the release gate'

node --input-type=module -e "
import { ARGON2ID_CONSTRAINED } from './packages/crypto/dist/index.js';
const { Vault } = await import('./packages/vault/dist/index.js');
Vault.create({ dir: '${weak}', passphrase: '${passphrase}', kdf: ARGON2ID_CONSTRAINED });
" || fail "could not make a floor vault to raise"

out="${tmp}/upgrade.out"
SERVANDA_VAULT="${weak}" SERVANDA_PASSPHRASE="${passphrase}" SERVANDA_UPGRADE_KEY=1 \
  node packages/node/dist/bin/servanda-init.js >"${out}" 2>"${tmp}/upgrade.err" \
  || { cat "${tmp}/upgrade.err" >&2; fail "SERVANDA_UPGRADE_KEY=1 did not complete"; }

grep -q 'Was  *m=65536 t=3 p=1' "${out}" || { cat "${out}" >&2; fail "the upgrade did not report the profile it started from"; }
grep -q 'Now  *m=1048576 t=2 p=4' "${out}" || { cat "${out}" >&2; fail "the upgrade did not land on the desktop profile"; }
grep -q 'Same passphrase, same recovery phrase, same personas' "${out}" \
  || { cat "${out}" >&2; fail "the upgrade did not say what it left alone"; }

# And the part that matters more than any message: the owner is not locked out. This open derives
# with the parameters now in the file, so it succeeds only if those are the ones that were spent.
node --input-type=module -e "
const { Vault } = await import('./packages/vault/dist/index.js');
const v = Vault.open({ dir: '${weak}', passphrase: '${passphrase}' });
const p = v.kdfProfile();
if (p === null || p.behindDefault) throw new Error('still behind after the upgrade: ' + JSON.stringify(p));
console.log(\`    raised to m=\${p.m} t=\${p.t} p=\${p.p}, and the same passphrase still opens it\`);
" || fail "the re-wrapped vault does not open with the passphrase it was re-wrapped under"

echo "==> GM: PASS"
