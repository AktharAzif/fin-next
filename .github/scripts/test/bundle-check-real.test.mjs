// The real-build test: bundle-check over every static app's real production build, built and
// staged as release.yml's static-build job builds them (release-static.mjs build: `turbo run build
// --force` for each app, source maps moved aside) and scanned as its static job scans them
// (`--artefacts`). Any finding fails it: a check that refuses an honest build fails the release,
// so a false-positive path that comes back fails here first. It builds, so it runs where the
// workspace is installed and FIN_REAL_BUILDS=1 asks for it (ci.yml's build job); elsewhere it is
// skipped and says why.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkArtefacts } from "../bundle-check.mjs";
import { build, RELEASE, staticOutputs } from "../release-static.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

describe("bundle-check over the real static builds", () => {
  it("finds nothing in any static app's real build, staged as the release stages it", (t) => {
    if (process.env.FIN_REAL_BUILDS !== "1") {
      t.skip("FIN_REAL_BUILDS=1 runs it after an install (ci.yml's build job): it builds the apps");
      return;
    }
    const layout = JSON.parse(readFileSync(join(ROOT, "tools", "layout.json"), "utf8"));
    const present = staticOutputs(layout).filter((o) =>
      existsSync(join(ROOT, "apps", o.app, "package.json")),
    );
    if (present.length === 0) {
      t.skip("no static app is on this branch yet");
      return;
    }
    const release = join(ROOT, RELEASE);
    assert.ok(!existsSync(release), `${RELEASE}/ is the release build's own folder: remove it`);
    t.after(() => rmSync(release, { recursive: true, force: true }));
    // The job's outputs and summary are the release's, not this test's.
    const env = { ...process.env };
    delete env.GITHUB_OUTPUT;
    delete env.GITHUB_STEP_SUMMARY;
    const { built } = build({ root: ROOT, env });
    assert.deepEqual(
      Object.keys(built).sort(),
      present.map((o) => o.key).sort(),
      "every static output of an app on this branch is built and staged",
    );
    const result = checkArtefacts(join(release, "static"));
    assert.equal(result.static, present.length);
    assert.deepEqual(result.findings, []);
  });
});
