#!/usr/bin/env bash
# The Bun canary (DECISIONS CI-10, R15): the shared packages' unit tests under Bun 1.4.5, to see
# early what would break if Fin ever ran on Bun. Non-blocking: ci.yml's bun job has
# continue-on-error and is not one of the jobs the gate needs. A control path.
# Each packages/<name> with a `test` script runs it with `bun --bun run test`, so the scripts' Node
# commands run on Bun; a failure is reported per package and fails this job only.
set -euo pipefail

ran=0
failed=()
for manifest in packages/*/package.json; do
  [ -f "$manifest" ] || continue
  dir="$(dirname "$manifest")"
  if ! node -e 'const s = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).scripts; process.exit(s && typeof s.test === "string" ? 0 : 1)' "$manifest"; then
    continue
  fi
  ran=$((ran + 1))
  echo "bun.canary package=${dir} start"
  if (cd "$dir" && bun --bun run test); then
    echo "bun.canary package=${dir} result=pass"
  else
    echo "bun.canary package=${dir} result=fail"
    failed+=("$dir")
  fi
done

if [ "$ran" -eq 0 ]; then
  echo "::notice title=bun canary::no package under packages/ has a test script yet; nothing ran"
  echo "bun.canary.result result=pass packages=0"
  exit 0
fi
if [ "${#failed[@]}" -gt 0 ]; then
  echo "::warning title=bun canary::${#failed[@]} of ${ran} package(s) fail under Bun: ${failed[*]}"
  echo "bun.canary.result result=fail packages=${ran} failed=${#failed[@]}"
  exit 1
fi
echo "bun.canary.result result=pass packages=${ran}"
