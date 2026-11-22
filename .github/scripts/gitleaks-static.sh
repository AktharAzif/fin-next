#!/usr/bin/env bash
# gitleaks over built static output (ARCHITECTURE §3.4 FW-C12, §11.2: no secret shape in a static
# build; §11.7: each static artefact passes the gitleaks scan). A control path. ci.yml's build job
# runs it over apps/*/dist/static, release.yml over each staged artefact (the previous release's
# carried assets included), with Fin's token shapes from .gitleaks.toml on top of gitleaks' own
# rules, findings redacted. gitleaks reads a folder it is given whatever .gitignore says.
# Usage: gitleaks-static.sh <dir>... ; an argument that is not a folder (a glob that matched
# nothing, while no app is built) is skipped with a notice. Exit 1 on a finding.
set -euo pipefail

config="${GITHUB_WORKSPACE:-$(pwd)}/.gitleaks.toml"
if [ ! -f "$config" ]; then
  echo "gitleaks-static: no .gitleaks.toml at the workspace root" >&2
  exit 2
fi

scanned=0
for dir in "$@"; do
  if [ -L "$dir" ] || [ ! -d "$dir" ]; then
    echo "::notice title=gitleaks-static::${dir//[^A-Za-z0-9._\/*-]/?} is not a built folder; skipped"
    continue
  fi
  echo "gitleaks.static dir=${dir//[^A-Za-z0-9._\/-]/?}"
  gitleaks dir --redact --no-banner --config "$config" "$dir"
  scanned=$((scanned + 1))
done
echo "gitleaks.static.result result=pass dirs=${scanned}"
