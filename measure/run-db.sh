#!/bin/sh
# MEASUREMENT ONLY (CI fix 3, apps/console; throwaway, never merged). The full db run exactly as the
# measurement commit runs it (turbo, every package, --continue), then each of the console's db files
# alone (one file, one worker), at this head, and the account file as it was at the base.
TURBO_TELEMETRY_DISABLED=1 turbo run test:db --continue
status=$?
cd apps/console || exit 1
for f in src/server/account.db.test.ts src/server/journey.db.test.ts src/server/step-up.db.test.ts src/server/policy.db.test.ts; do
  echo "ci-f3-alone head $f"
  FIN_SPLIT_PHASE=alone-head pnpm exec vitest run --config ../../vitest.config.ts --mode db "$f"
done
cp ../../measure/account.base.txt src/server/account.db.test.ts
echo "ci-f3-alone base src/server/account.db.test.ts"
FIN_SPLIT_PHASE=alone-base pnpm exec vitest run --config ../../vitest.config.ts --mode db src/server/account.db.test.ts
git checkout -- src/server/account.db.test.ts 2>/dev/null || true
exit $status
