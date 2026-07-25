#!/usr/bin/env bash
# Resync vendor/vectors from a checkout of servanda-protocol and re-pin the source commit.
set -euo pipefail

cd "$(dirname "$0")/.."
SRC="${1:-../servanda-protocol}"

if [ ! -d "${SRC}/vectors" ]; then
  echo "FAIL: no vectors directory at ${SRC}/vectors" >&2
  exit 1
fi

rm -rf vendor/vectors
cp -R "${SRC}/vectors" vendor/vectors
git -C "${SRC}" rev-parse HEAD > vendor/vectors/.SOURCE_COMMIT

echo "synced vendor/vectors from ${SRC} @ $(cat vendor/vectors/.SOURCE_COMMIT)"
echo "re-run: bash gates/g0-vectors.sh"
