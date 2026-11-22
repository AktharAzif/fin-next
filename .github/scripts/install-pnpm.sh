#!/usr/bin/env bash
# pnpm 12.21.0 from its release asset, checked against its SHA-256 before it runs (spec 01 §4.1,
# §5.3; ARCHITECTURE §11.5): never a setup action, never Corepack, never `npm i -g`. The same asset
# and checksum as ops/docker's Dockerfiles. A control path. Linux x64 runners only.
#
# The asset is a tarball holding the standalone `pnpm` executable and its `dist/`. It is unpacked
# under $RUNNER_TEMP and that folder is put on the job's PATH.
set -euo pipefail

version="12.21.0"
sha256="84c4773bcf4a217f4083cd7b2a91e4cee6103cf42426c1282ef37d308f55a410"
url="https://github.com/pnpm/pnpm/releases/download/v${version}/pnpm-linux-x64.tar.gz"

if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
  echo "install-pnpm: this script installs the linux-x64 asset only" >&2
  exit 64
fi
: "${RUNNER_TEMP:?install-pnpm: RUNNER_TEMP is not set}"
: "${GITHUB_PATH:?install-pnpm: GITHUB_PATH is not set}"

started_ms="$(date +%s%3N)"
dest="${RUNNER_TEMP}/fin-pnpm/${version}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 \
  --output "${work}/pnpm.tar.gz" "$url"
echo "${sha256}  ${work}/pnpm.tar.gz" | sha256sum --check --strict --quiet -

rm -rf "$dest"
mkdir -p "$dest"
tar -xzf "${work}/pnpm.tar.gz" -C "$dest"
actual="$("${dest}/pnpm" --version)"
if [ "$actual" != "$version" ]; then
  echo "install-pnpm: expected pnpm ${version}, got ${actual}" >&2
  exit 1
fi
echo "$dest" >> "$GITHUB_PATH"
echo "install.tool name=pnpm version=${version} sha256=${sha256} ms=$(( $(date +%s%3N) - started_ms ))"
