// The engine copy (spec 07 §0.3): a gating run is judged only by the default branch's engine and
// procedure, from a clean checkout; the procedure hash of §4.8 is recorded.

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { checkEngineCopy, procedureHash } from "../src/review/engine-copy.ts";
import { FixtureRepo, tempDir } from "./helpers/git-fixture.ts";

describe("the engine copy check", () => {
  let tmp: ReturnType<typeof tempDir>;
  let engine: FixtureRepo;
  let main: string;
  const env = (): Record<string, string> => ({ PATH: process.env["PATH"] ?? "", HOME: tmp.dir });
  const files = {
    "tools/fin-review/src/main.ts": "export {};\n",
    "tools/fin-review/config/floor.json": "{}\n",
    "docs/review/README.md": "# review\n",
    "AGENTS.md": "# agents\n",
  };

  before(() => {
    tmp = tempDir("engine");
    mkdirSync(join(tmp.dir, "engine"));
    engine = new FixtureRepo(join(tmp.dir, "engine"));
    main = engine.commit(null, files);
    engine.git(["checkout", "-q", "--detach", main]);
  });
  after(() => tmp.cleanup());

  const check = (defaultTip: string) => checkEngineCopy(engine.dir, { mirror: engine.dir, defaultBranch: "main", defaultTip, env: env() });

  it("passes a clean checkout of the default branch's engine, and records its commit and procedure hash", async () => {
    const copy = await check(main);
    assert.deepEqual(copy.problems, []);
    assert.equal(copy.commit, main);
    const oids = engine
      .git(["ls-tree", "-r", main, "--", "docs/review", "tools/fin-review/config"])
      .trim()
      .split("\n")
      .map((line): [string, string] => {
        const [meta = "", path = ""] = line.split("\t");
        return [path, meta.split(" ")[2] ?? ""];
      });
    assert.equal(oids.length, 2);
    assert.equal(copy.procedureHash, procedureHash(oids));
    assert.match(copy.procedureHash ?? "", /^[0-9a-f]{64}$/);
  });

  it("refuses a checkout with a change, an untracked or an ignored file under the engine's paths", async () => {
    writeFileSync(join(engine.dir, "docs/review/README.md"), "# review, edited\n");
    try {
      assert.match((await check(main)).problems.join("\n"), /has changes under .*: docs\/review\/README\.md/);
    } finally {
      engine.git(["checkout", "-q", "--", "docs/review/README.md"]);
    }
    writeFileSync(join(engine.dir, "docs/review/rules-digest.md"), "# digest\n");
    try {
      assert.match((await check(main)).problems.join("\n"), /docs\/review\/rules-digest\.md/);
    } finally {
      rmSync(join(engine.dir, "docs/review/rules-digest.md"));
    }
    assert.deepEqual((await check(main)).problems, []);
  });

  it("refuses an engine whose procedure or code differs from the default branch's, and a default branch with no engine", async () => {
    const newer = engine.commit(main, { "docs/review/README.md": "# review, as main has it now\n" });
    assert.match((await check(newer)).problems.join("\n"), /docs\/review at the engine's commit differs from main's/);
    const bare = engine.commit(null, { "README.md": "# r\n" });
    assert.match((await check(bare)).problems.join("\n"), /main has no tools\/fin-review, so there is no engine copy to run/);
  });

  it("refuses an engine that does not run from a git checkout", async () => {
    const plain = join(tmp.dir, "plain");
    mkdirSync(plain);
    const copy = await checkEngineCopy(plain, { mirror: engine.dir, defaultBranch: "main", defaultTip: main, env: env() });
    assert.deepEqual(copy.problems, ["the engine does not run from a git checkout"]);
  });
});
