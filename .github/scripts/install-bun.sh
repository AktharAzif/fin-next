#!/usr/bin/env bash
# Bun 1.4.5 for the non-blocking Bun canary (DECISIONS CI-10, R15), from its release asset checked
# against the SHA-256 the release publishes (SHASUMS256.txt, read on 21 Nov 2026; it matches the
# digest GitHub records for the asset). The repository allows GitHub-owned actions only, so no
# setup action is used. A control path. Linux x64 runners only.
set -euo pipefail

version="1.4.5"
sha256="94559b3b528995a49452f9f2404cec74f2efd7d06e0a000a8cd214b02c3666eb"
url="https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-linux-x64.zip"

if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
  echo "install-bun: this script installs the linux-x64 asset only" >&2
  exit 64
fi
: "${RUNNER_TEMP:?install-bun: RUNNER_TEMP is not set}"
: "${GITHUB_PATH:?install-bun: GITHUB_PATH is not set}"

started_ms="$(date +%s%3N)"
dest="${RUNNER_TEMP}/fin-bun/${version}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 \
  --output "${work}/bun.zip" "$url"
echo "${sha256}  ${work}/bun.zip" | sha256sum --check --strict --quiet -

mkdir -p "${work}/x" "$dest"
unzip -q "${work}/bun.zip" "bun-linux-x64/bun" -d "${work}/x"
install -m 0755 "${work}/x/bun-linux-x64/bun" "${dest}/bun"
actual="$("${dest}/bun" --version)"
if [ "$actual" != "$version" ]; then
  echo "install-bun: expected Bun ${version}, got ${actual}" >&2
  exit 1
fi
echo "$dest" >> "$GITHUB_PATH"
echo "install.tool name=bun version=${version} sha256=${sha256} ms=$(( $(date +%s%3N) - started_ms ))"
