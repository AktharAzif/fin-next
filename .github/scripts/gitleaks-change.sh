#!/usr/bin/env bash
# gitleaks over what this run brings (spec 01 §5.3's static job; DECISIONS CI-16): Fin's token
# shapes from .gitleaks.toml on top of gitleaks' own rules, findings redacted. A control path.
#   pull_request  the pull request's commits, BASE_SHA..HEAD_SHA
#   push          the pushed commits, BASE_SHA..HEAD_SHA (the head commit alone for a new branch)
#   otherwise     (workflow_dispatch) every commit HEAD_SHA holds that main does not, from
#                 refs/remotes/origin/main, which the job's full checkout fetches: a run started by
#                 hand on a pull request's branch reports for its head, so it scans everything the
#                 branch would bring, never the head alone; without main's ref the input is unusable
# The static job also scans the checked-out tree; nightly.yml scans main's whole history.
# Inputs (environment): EVENT_NAME, BASE_SHA, HEAD_SHA.
set -euo pipefail

sha_re='^[0-9a-f]{40}$'
zero="0000000000000000000000000000000000000000"
event="${EVENT_NAME:-}"
base="${BASE_SHA:-}"
head="${HEAD_SHA:-}"

if ! [[ "$head" =~ $sha_re ]]; then
  echo "gitleaks-change: HEAD_SHA is not a commit SHA" >&2
  exit 2
fi
if [ -n "$base" ] && ! [[ "$base" =~ $sha_re ]]; then
  echo "gitleaks-change: BASE_SHA is not a commit SHA" >&2
  exit 2
fi

if [ "$event" = "pull_request" ] || { [ "$event" = "push" ] && [ -n "$base" ] && [ "$base" != "$zero" ]; }; then
  if [ -z "$base" ]; then
    echo "gitleaks-change: a pull request needs BASE_SHA" >&2
    exit 2
  fi
  log_opts="${base}..${head}"
elif [ "$event" = "push" ]; then
  log_opts="-1 ${head}"
else
  main="$(git rev-parse --verify --quiet 'refs/remotes/origin/main^{commit}' || true)"
  if ! [[ "$main" =~ $sha_re ]]; then
    echo "gitleaks-change: main's commit (refs/remotes/origin/main) cannot be read" >&2
    exit 2
  fi
  log_opts="${main}..${head}"
fi

echo "gitleaks.change event=${event} range=${log_opts// /:}"
gitleaks git --redact --no-banner --config .gitleaks.toml --log-opts="$log_opts" .
