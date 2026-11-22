#!/usr/bin/env bash
# The CI tools that are not actions, each from its release, checked against the SHA-256 that
# release publishes before it runs (spec 01 §5.1; ARCHITECTURE §11.5). A control path. Linux x64
# runners only. Usage: install-tools.sh <tool>... where a tool is one of the names below.
#
# The versions are spec 01 §5.1's; each checksum was read from its release on 21 Nov 2026 and
# matches the digest GitHub records for the asset:
#   zizmor       1.32.0  the release publishes no checksum file; GitHub's asset digest
#   actionlint   1.7.12  actionlint_1.7.12_checksums.txt
#   gitleaks     8.30.1  gitleaks_8.30.1_checksums.txt
#   osv-scanner  2.7.1   osv-scanner_SHA256SUMS
# Moving a version is a reviewed change to this file: the new asset's checksum, read from its
# release, replaces the old one here.
set -euo pipefail

if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
  echo "install-tools: this script installs linux-x64 assets only" >&2
  exit 64
fi
: "${RUNNER_TEMP:?install-tools: RUNNER_TEMP is not set}"
: "${GITHUB_PATH:?install-tools: GITHUB_PATH is not set}"
if [ "$#" -eq 0 ]; then
  echo "usage: install-tools.sh zizmor|actionlint|gitleaks|osv-scanner..." >&2
  exit 64
fi

dest="${RUNNER_TEMP}/fin-tools/bin"
mkdir -p "$dest"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

install_tool() {
  local name="$1" version url sha256 kind member started_ms
  case "$name" in
    zizmor)
      version="1.32.0"
      url="https://github.com/zizmorcore/zizmor/releases/download/v${version}/zizmor-x86_64-unknown-linux-gnu.tar.gz"
      sha256="bb110cc765eca9cd7efb2e284a956be5974c60027b0970f16397d86208a9957b"
      kind="tar"
      member="zizmor"
      ;;
    actionlint)
      version="1.7.12"
      url="https://github.com/rhysd/actionlint/releases/download/v${version}/actionlint_${version}_linux_amd64.tar.gz"
      sha256="8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"
      kind="tar"
      member="actionlint"
      ;;
    gitleaks)
      version="8.30.1"
      url="https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_linux_x64.tar.gz"
      sha256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
      kind="tar"
      member="gitleaks"
      ;;
    osv-scanner)
      version="2.7.1"
      url="https://github.com/google/osv-scanner/releases/download/v${version}/osv-scanner_linux_amd64"
      sha256="fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8"
      kind="binary"
      member="osv-scanner"
      ;;
    *)
      echo "install-tools: unknown tool: ${name}" >&2
      return 64
      ;;
  esac
  started_ms="$(date +%s%3N)"
  local file="${work}/${name}.download"
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 3 \
    --output "$file" "$url"
  echo "${sha256}  ${file}" | sha256sum --check --strict --quiet -
  if [ "$kind" = "tar" ]; then
    mkdir -p "${work}/${name}"
    tar -xzf "$file" -C "${work}/${name}" "$member"
    install -m 0755 "${work}/${name}/${member}" "${dest}/${name}"
  else
    install -m 0755 "$file" "${dest}/${name}"
  fi
  local reported
  case "$name" in
    actionlint) reported="$("${dest}/${name}" -version)" ;;
    gitleaks) reported="$("${dest}/${name}" version)" ;;
    *) reported="$("${dest}/${name}" --version)" ;;
  esac
  case "$reported" in
    *"$version"*) ;;
    *)
      echo "install-tools: ${name} reports a version other than ${version}" >&2
      return 1
      ;;
  esac
  echo "install.tool name=${name} version=${version} sha256=${sha256} ms=$(( $(date +%s%3N) - started_ms ))"
}

for tool in "$@"; do
  install_tool "$tool"
done
echo "$dest" >> "$GITHUB_PATH"
