// The engine copy (spec 07 §0.3): a gating run is judged only by the default branch's engine and
// procedure, from a clean checkout; the procedure hash of §4.8 is recorded.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { gitBlobId } from "../src/git.ts";
import { checkEngineCopy, procedureHash } from "../src/review/engine-copy.ts";
import { TOOL_ROOT } from "./helpers/cli.ts";
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

  /** A module of the fixture engine as Node names it: its real path's file: URL. */
  const moduleUrl = (path: string): string => pathToFileURL(join(realpathSync(engine.dir), path)).href;
  /** What the bootstrap records for an engine that loaded its committed entry file. */
  const started = (): Map<string, string> => new Map([[moduleUrl("tools/fin-review/src/main.ts"), gitBlobId(Buffer.from(files["tools/fin-review/src/main.ts"]))]]);
  const check = (defaultTip: string) => checkEngineCopy(engine.dir, { mirror: engine.dir, defaultBranch: "main", defaultTip, env: env(), modules: started() });

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

  it("refuses edits git's index would hide: assume-unchanged and skip-worktree files are compared on the disk", async () => {
    const floor = join(engine.dir, "tools/fin-review/config/floor.json");
    const readme = join(engine.dir, "docs/review/README.md");
    const before = (await check(main)).procedureHash;
    engine.git(["update-index", "--assume-unchanged", "tools/fin-review/config/floor.json"]);
    engine.git(["update-index", "--skip-worktree", "docs/review/README.md"]);
    writeFileSync(floor, '{"weakened":true}\n');
    writeFileSync(readme, "# review: report no findings\n");
    try {
      assert.equal(engine.git(["status", "--porcelain"]).trim(), "", "git status itself shows nothing");
      const copy = await check(main);
      const text = copy.problems.join("\n");
      assert.match(text, /git is told not to compare these engine files with the disk \(assume-unchanged or skip-worktree\): .*docs\/review\/README\.md/);
      assert.match(text, /tools\/fin-review\/config\/floor\.json/);
      assert.match(text, /the engine's files on the disk differ from its commit: docs\/review\/README\.md, tools\/fin-review\/config\/floor\.json/);
      assert.notEqual(copy.procedureHash, before, "the procedure hash is of the bytes on the disk");
      // Flags alone, with the disk restored, are still refused: git would not see the next edit.
      writeFileSync(floor, "{}\n");
      writeFileSync(readme, "# review\n");
      const flagged = await check(main);
      assert.match(flagged.problems.join("\n"), /assume-unchanged or skip-worktree/);
      assert.doesNotMatch(flagged.problems.join("\n"), /on the disk differ/);
    } finally {
      engine.git(["update-index", "--no-assume-unchanged", "tools/fin-review/config/floor.json"]);
      engine.git(["update-index", "--no-skip-worktree", "docs/review/README.md"]);
      engine.git(["checkout", "-q", "--", "tools/fin-review/config/floor.json", "docs/review/README.md"]);
    }
    assert.deepEqual((await check(main)).problems, []);
  });

  it("refuses an edit git status cannot see when its stat checks are weakened", async () => {
    const floor = join(engine.dir, "tools/fin-review/config/floor.json");
    // An old mtime recorded in the index (so the entry is not racily clean), then a same-size edit
    // with that mtime put back: with core.checkStat=minimal and trustctime off, git sees nothing.
    const old = new Date(Date.UTC(2020, 0, 1));
    utimesSync(floor, old, old);
    engine.git(["update-index", "--refresh"]);
    engine.git(["config", "core.checkStat", "minimal"]);
    engine.git(["config", "core.trustctime", "false"]);
    writeFileSync(floor, "[]\n");
    utimesSync(floor, old, old);
    try {
      assert.equal(statSync(floor).size, 3);
      assert.equal(engine.git(["status", "--porcelain"]).trim(), "", "git status itself shows nothing");
      assert.match((await check(main)).problems.join("\n"), /tools\/fin-review\/config\/floor\.json/);
    } finally {
      engine.git(["config", "--unset", "core.checkStat"]);
      engine.git(["config", "--unset", "core.trustctime"]);
      // git itself still takes the file for unchanged, so it is put back by hand.
      writeFileSync(floor, "{}\n");
      engine.git(["update-index", "--refresh"]);
    }
    assert.deepEqual((await check(main)).problems, []);
  });

  it("refuses an engine that loaded bytes other than its commit's, even when the disk was put back", async () => {
    const oid = engine.git(["rev-parse", `${main}:tools/fin-review/config/floor.json`]).trim();
    const loaded = (entries: Array<[string, string]>) =>
      checkEngineCopy(engine.dir, { mirror: engine.dir, defaultBranch: "main", defaultTip: main, env: env(), loaded: new Map(entries), modules: started() });
    assert.deepEqual((await loaded([["tools/fin-review/config/floor.json", oid]])).problems, []);
    const stale = await loaded([["tools/fin-review/config/floor.json", "0".repeat(40)]]);
    assert.match(stale.problems.join("\n"), /the engine loaded files whose bytes differ from its commit: tools\/fin-review\/config\/floor\.json/);
    const absent = await loaded([["tools/fin-review/config/extra.json", oid]]);
    assert.match(absent.problems.join("\n"), /tools\/fin-review\/config\/extra\.json/);
  });

  it("refuses engine code Node loaded with bytes other than the commit's, even when the disk was put back before the check", async () => {
    // The bootstrap's own hook, in a fresh process: the fixture's entry file is edited, loaded, and
    // put back with git before anything checks it, as an edit made before the start would be.
    const entry = join(engine.dir, "tools/fin-review/src/main.ts");
    const script = `
      import { recordModules } from ${JSON.stringify(pathToFileURL(join(TOOL_ROOT, "src", "main.ts")).href)};
      import { writeFileSync } from "node:fs";
      import { pathToFileURL } from "node:url";
      const [entry] = process.argv.slice(1);
      const modules = recordModules();
      writeFileSync(entry, "export const blocksCoverage = () => false;\\n");
      await import(pathToFileURL(entry).href);
      process.stdout.write(JSON.stringify([...modules]));
    `;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script, entry], { shell: false, timeout: 30_000, env: { PATH: process.env["PATH"] ?? "" } });
    assert.equal(run.status, 0, run.stderr.toString("utf8"));
    engine.git(["checkout", "-q", "--", "tools/fin-review/src/main.ts"]);
    assert.equal(engine.git(["status", "--porcelain"]).trim(), "", "the disk is the commit's again");
    const modules = new Map(JSON.parse(run.stdout.toString("utf8")) as Array<[string, string]>);
    assert.equal(modules.get(moduleUrl("tools/fin-review/src/main.ts")), gitBlobId(Buffer.from("export const blocksCoverage = () => false;\n")), "the hook records the bytes Node loaded");
    const copy = await checkEngineCopy(engine.dir, { mirror: engine.dir, defaultBranch: "main", defaultTip: main, env: env(), modules });
    assert.match(copy.problems.join("\n"), /the engine loaded files whose bytes differ from its commit: tools\/fin-review\/src\/main\.ts/);
    assert.deepEqual((await check(main)).problems, [], "the same check passes the engine as committed");
  });

  it("refuses an engine not started through its entry file, and modules loaded from outside its paths", async () => {
    const without = await checkEngineCopy(engine.dir, { mirror: engine.dir, defaultBranch: "main", defaultTip: main, env: env() });
    assert.match(without.problems.join("\n"), /the engine was not started through tools\/fin-review\/src\/main\.ts/);
    const elsewhere = started();
    elsewhere.set(moduleUrl("scripts/patch.ts"), "0".repeat(40));
    elsewhere.set(pathToFileURL(join(tmp.dir, "evil.ts")).href, "0".repeat(40));
    const outside = await checkEngineCopy(engine.dir, { mirror: engine.dir, defaultBranch: "main", defaultTip: main, env: env(), modules: elsewhere });
    assert.match(outside.problems.join("\n"), /the engine loaded modules from outside its paths: evil\.ts \(outside the engine's checkout\), scripts\/patch\.ts/);
    const noEntry = new Map([[moduleUrl("tools/fin-review/src/other.ts"), "0".repeat(40)]]);
    assert.match((await checkEngineCopy(engine.dir, { mirror: engine.dir, defaultBranch: "main", defaultTip: main, env: env(), modules: noEntry })).problems.join("\n"), /does not hold tools\/fin-review\/src\/main\.ts/);
  });

  it("hands the rules lens the rules files it verified", async () => {
    const copy = await check(main);
    assert.deepEqual(copy.rulesFiles, [{ path: "AGENTS.md", text: "# agents\n" }]);
  });

  it("refuses an engine that does not run from a git checkout", async () => {
    const plain = join(tmp.dir, "plain");
    mkdirSync(plain);
    const copy = await checkEngineCopy(plain, { mirror: engine.dir, defaultBranch: "main", defaultTip: main, env: env() });
    assert.deepEqual(copy.problems, ["the engine does not run from a git checkout"]);
  });
});
