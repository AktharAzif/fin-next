// The git output parsers, the git calls and the program runner (spec 07 §2.1's process rules).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ProgramError } from "../src/errors.ts";
import { resolveProgram, runProgram } from "../src/exec.ts";
import {
  gitEnv,
  isSha,
  mergeBases,
  parseCatFileBatch,
  parseLsTreeZ,
  parseRawDiffZ,
  promisorRemote,
  readBlobs,
} from "../src/git.ts";
import { FixtureRepo, fixtureEnv, runGit, tempDir } from "./helpers/git-fixture.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const Z = "0".repeat(40);
const POSIX = process.platform !== "win32";

describe("parseRawDiffZ", () => {
  it("reads every status with both modes, renames and copies at both paths", () => {
    const raw = [
      `:100644 100644 ${A} ${B} M`,
      "src/a.ts",
      `:000000 100644 ${Z} ${A} A`,
      "new file.ts",
      `:100644 000000 ${A} ${Z} D`,
      "gone\nwith newline.ts",
      `:100644 100644 ${A} ${B} R087`,
      "old/x.ts",
      "new/x.ts",
      `:100644 100644 ${A} ${A} C100`,
      "src/b.ts",
      "src/b copy.ts",
      `:100644 120000 ${A} ${B} T`,
      "link",
      `:000000 160000 ${Z} ${B} A`,
      "vendor/sub",
      "",
    ].join("\0");
    assert.deepEqual(parseRawDiffZ(Buffer.from(raw, "utf8")), [
      {
        status: "M",
        score: null,
        path: "src/a.ts",
        oldPath: null,
        oldMode: "100644",
        newMode: "100644",
      },
      {
        status: "A",
        score: null,
        path: "new file.ts",
        oldPath: null,
        oldMode: "000000",
        newMode: "100644",
      },
      {
        status: "D",
        score: null,
        path: "gone\nwith newline.ts",
        oldPath: null,
        oldMode: "100644",
        newMode: "000000",
      },
      {
        status: "R",
        score: 87,
        path: "new/x.ts",
        oldPath: "old/x.ts",
        oldMode: "100644",
        newMode: "100644",
      },
      {
        status: "C",
        score: 100,
        path: "src/b copy.ts",
        oldPath: "src/b.ts",
        oldMode: "100644",
        newMode: "100644",
      },
      {
        status: "T",
        score: null,
        path: "link",
        oldPath: null,
        oldMode: "100644",
        newMode: "120000",
      },
      {
        status: "A",
        score: null,
        path: "vendor/sub",
        oldPath: null,
        oldMode: "000000",
        newMode: "160000",
      },
    ]);
    assert.deepEqual(parseRawDiffZ(Buffer.alloc(0)), []);
  });

  it("refuses output it does not recognise", () => {
    for (const raw of [
      `:100644 100644 ${A} ${B} M\0a`,
      `:100644 100644 ${A} ${B} Z\0a\0`,
      `:100644 100644 ${A} ${B} R100\0only-one\0`,
      `:100644 100644 ${A} ${B} M\0`,
      `:100644 100644 ${A} ${B} MM\0a\0`,
      `:100644 100644 ${A} ${B} R1000\0a\0b\0`,
      `:100644 100644 ${A} ${B} M90\0a\0`,
      `:10064 100644 ${A} ${B} M\0a\0`,
      `:100644 100644 ${A.slice(1)} ${B} M\0a\0`,
      "M\0a\0",
    ]) {
      assert.throws(() => parseRawDiffZ(Buffer.from(raw, "utf8")), TypeError, JSON.stringify(raw));
    }
  });
});

describe("parseLsTreeZ", () => {
  it("reads mode, type, object and path, names with tabs and newlines included", () => {
    const raw = [
      `100644 blob ${A}\tpackage.json`,
      `100755 blob ${B}\tbin/run me`,
      `160000 commit ${A}\tvendor/sub`,
      `100644 blob ${B}\ta\tb\nc`,
      "",
    ].join("\u0000");
    assert.deepEqual(parseLsTreeZ(Buffer.from(raw, "utf8")), [
      { mode: "100644", type: "blob", oid: A, path: "package.json" },
      { mode: "100755", type: "blob", oid: B, path: "bin/run me" },
      { mode: "160000", type: "commit", oid: A, path: "vendor/sub" },
      { mode: "100644", type: "blob", oid: B, path: "a\tb\nc" },
    ]);
  });

  it("refuses malformed records", () => {
    for (const raw of [
      `100644 blob ${A} package.json\0`,
      `100644 blob xyz\tpackage.json\0`,
      `10064 blob ${A}\tp\0`,
      `100644 blob ${A} extra\tp\0`,
      `100644 blob ${A}\tp`,
    ]) {
      assert.throws(() => parseLsTreeZ(Buffer.from(raw, "utf8")), TypeError, JSON.stringify(raw));
    }
  });
});

describe("parseCatFileBatch", () => {
  it("reads blobs by object ID, binary content and missing objects included", () => {
    const body = Buffer.from([0x00, 0x0a, 0xff, 0x41]);
    const raw = Buffer.concat([
      Buffer.from(`${A} blob 4\n`),
      body,
      Buffer.from(`\n${B} missing\n`),
    ]);
    const out = parseCatFileBatch(raw, [A, B]);
    assert.deepEqual([...out.keys()], [A]);
    assert.deepEqual(out.get(A), body);
  });

  it("refuses truncated or mismatched output", () => {
    assert.throws(() => parseCatFileBatch(Buffer.from(`${A} blob 10\nshort\n`), [A]), TypeError);
    assert.throws(() => parseCatFileBatch(Buffer.from(`${B} blob 1\nx\n`), [A]), TypeError);
    assert.throws(() => parseCatFileBatch(Buffer.from(""), [A]), TypeError);
  });
});

describe("gitEnv and isSha", () => {
  it("drops every GIT_* variable and pins prompts, locks and locale", () => {
    const env = gitEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      GIT_DIR: "/evil",
      git_work_tree: "/evil",
      GIT_EXTERNAL_DIFF: "x",
      GIT_CONFIG_PARAMETERS: "'a.b=c'",
      UNSET: undefined,
    });
    assert.deepEqual(env, {
      PATH: "/usr/bin",
      HOME: "/home/x",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      LC_ALL: "C",
    });
  });

  it("accepts only 40 lower-case hex characters", () => {
    assert.equal(isSha(A), true);
    for (const value of [
      A.toUpperCase(),
      A.slice(1),
      `${A}0`,
      `${A.slice(1)}g`,
      "HEAD",
      "",
      5,
      null,
      `${A.slice(0, 39)}\n`,
    ]) {
      assert.equal(isSha(value), false, JSON.stringify(value));
    }
  });
});

describe("mergeBases", () => {
  let tmp: ReturnType<typeof tempDir>;
  let repo: FixtureRepo;
  before(() => {
    tmp = tempDir("merge-bases");
    repo = new FixtureRepo(tmp.dir);
  });
  after(() => tmp.cleanup());

  it("finds one, several or no merge bases", async () => {
    const env = fixtureEnv(tmp.dir);
    const root = repo.commit(null, { "a.txt": "a\n" });
    const left = repo.commit(root, { "l.txt": "l\n" });
    const right = repo.commit(root, { "r.txt": "r\n" });
    assert.deepEqual(await mergeBases(tmp.dir, left, right, env), [root]);
    const one = repo.commit([left, right], {});
    const two = repo.commit([right, left], {});
    assert.deepEqual((await mergeBases(tmp.dir, one, two, env)).sort(), [left, right].sort());
    const other = repo.commit(null, { "b.txt": "b\n" });
    assert.deepEqual(await mergeBases(tmp.dir, left, other, env), []);
    await assert.rejects(mergeBases(tmp.dir, "1".repeat(40), left, env), ProgramError);
  });
});

describe("readBlobs in a blobless clone", () => {
  let tmp: ReturnType<typeof tempDir>;
  let source: FixtureRepo;
  let clone: string;
  let oids: string[];
  const files = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [
      `packages/p${i}/package.json`,
      `{"name":"@fin/p${i}","version":"1.0.${i}"}\n`,
    ]),
  );

  before(() => {
    tmp = tempDir("partial");
    const origin = join(tmp.dir, "origin");
    mkdirSync(origin);
    source = new FixtureRepo(origin);
    const head = source.commit(null, files);
    source.git(["update-ref", "refs/heads/main", head]);
    source.git(["symbolic-ref", "HEAD", "refs/heads/main"]);
    source.git(["config", "uploadpack.allowFilter", "true"]);
    source.git(["config", "uploadpack.allowAnySHA1InWant", "true"]);
    clone = join(tmp.dir, "clone");
    runGit(tmp.dir, [
      "clone",
      "--quiet",
      "--filter=blob:none",
      "--no-checkout",
      `file://${origin}`,
      clone,
    ]);
    oids = runGit(clone, ["ls-tree", "-r", "--format=%(objectname)", "origin/main"])
      .trim()
      .split("\n");
    assert.equal(oids.length, 20);
  });
  after(() => tmp.cleanup());

  function promisorPacks(): number {
    return readdirSync(join(clone, ".git", "objects", "pack")).filter((name) =>
      name.endsWith(".promisor"),
    ).length;
  }

  it("fetches every missing blob in one request", async () => {
    const env = fixtureEnv(tmp.dir);
    assert.equal(await promisorRemote(clone, env), "origin");
    const before = promisorPacks();
    const read = await readBlobs(clone, oids, env);
    assert.deepEqual(read.problems, []);
    assert.equal(read.blobs.size, 20);
    for (const [path, content] of Object.entries(files)) {
      const oid = runGit(clone, ["rev-parse", `origin/main:${path}`]).trim();
      assert.equal(read.blobs.get(oid)?.toString("utf8"), content, path);
    }
    assert.equal(promisorPacks() - before, 1, "one fetch, not one per object");
  });

  it("leaves out an object that is missing in a full repository, with no fetch", async () => {
    const env = fixtureEnv(tmp.dir);
    const origin = join(tmp.dir, "origin");
    assert.equal(await promisorRemote(origin, env), null);
    const read = await readBlobs(origin, [...oids.slice(0, 2), "9".repeat(40)], env);
    assert.equal(read.blobs.size, 2);
    assert.deepEqual(read.problems, []);
  });

  it("reports a failed fetch and returns what is present", async () => {
    const env = fixtureEnv(tmp.dir);
    const broken = join(tmp.dir, "broken");
    runGit(tmp.dir, [
      "clone",
      "--quiet",
      "--filter=blob:none",
      "--no-checkout",
      `file://${join(tmp.dir, "origin")}`,
      broken,
    ]);
    runGit(broken, ["remote", "set-url", "origin", `file://${join(tmp.dir, "nowhere")}`]);
    const read = await readBlobs(broken, oids.slice(0, 3), env);
    assert.equal(read.blobs.size, 0);
    assert.match(read.problems[0] ?? "", /could not fetch 3 missing objects/);
  });
});

describe("runProgram", () => {
  const node = process.execPath;
  const base = {
    cwd: process.cwd(),
    env: { PATH: process.env["PATH"] ?? "" },
    timeoutMs: 10_000,
    maxOutputBytes: 1 << 20,
  };

  it("passes arguments as an array with no shell, and the given environment only", async () => {
    const result = await runProgram(
      node,
      [
        "-e",
        "process.stdout.write(JSON.stringify([process.argv.slice(1), Object.keys(process.env).sort()]))",
        "a b",
        "$(echo hi)",
        "; rm -rf /",
      ],
      {
        ...base,
        env: { PATH: process.env["PATH"] ?? "", ONLY: "1" },
      },
    );
    assert.equal(result.code, 0);
    const [argv, keys] = JSON.parse(result.stdout.toString("utf8")) as [string[], string[]];
    assert.deepEqual(argv, ["a b", "$(echo hi)", "; rm -rf /"]);
    assert.ok(keys.includes("ONLY"));
    assert.ok(!keys.includes("HOME"));
  });

  it("writes stdin and reports a non-zero exit", async () => {
    const echo = await runProgram(node, ["-e", "process.stdin.pipe(process.stdout)"], {
      ...base,
      input: Buffer.from("piped"),
    });
    assert.equal(echo.stdout.toString("utf8"), "piped");
    const fail = await runProgram(
      node,
      ["-e", "process.stderr.write('bad'); process.exit(3)"],
      base,
    );
    assert.deepEqual([fail.code, fail.stderr.toString("utf8")], [3, "bad"]);
  });

  it("kills a program that runs past its timeout", async () => {
    await assert.rejects(
      runProgram(node, ["-e", "setTimeout(() => {}, 60000)"], { ...base, timeoutMs: 200 }),
      (error: unknown) => error instanceof ProgramError && /timed out/.test(error.message),
    );
  });

  it("kills a program that writes past the cap", async () => {
    await assert.rejects(
      runProgram(node, ["-e", "process.stdout.write('x'.repeat(100000))"], {
        ...base,
        maxOutputBytes: 1000,
      }),
      (error: unknown) =>
        error instanceof ProgramError && /more than 1000 bytes/.test(error.message),
    );
  });

  it("rejects a program that cannot start, and refuses suspicious program names and arguments", async () => {
    await assert.rejects(runProgram("fin-review-no-such-program", [], base), ProgramError);
    await assert.rejects(runProgram("git; rm", [], base), TypeError);
    await assert.rejects(runProgram("git", ["a\0b"], base), TypeError);
    await assert.rejects(runProgram("git", [], { ...base, timeoutMs: 0 }), TypeError);
    await assert.rejects(runProgram("git", [], { ...base, maxOutputBytes: 0 }), TypeError);
    await assert.rejects(
      runProgram("bin/git", [], base),
      ProgramError,
      "a relative path would resolve against the working directory",
    );
  });

  describe("a grandchild that holds the output pipes", () => {
    let tmp: ReturnType<typeof tempDir>;
    before(() => {
      tmp = tempDir("grandchild");
    });
    after(() => tmp.cleanup());

    /** A node script that starts a grandchild sharing its stdio, records the grandchild's pid, then `then`. */
    function parentScript(pidFile: string, grandchild: string, then: string): string[] {
      const script = `
        const { spawn } = require("node:child_process");
        const { writeFileSync } = require("node:fs");
        const child = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "inherit" });
        writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
        ${then}
      `;
      return ["-e", script];
    }

    async function gone(pid: number): Promise<boolean> {
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    }

    it("a timeout settles the call at once and kills the grandchild too", async () => {
      const pidFile = join(tmp.dir, "hang.pid");
      const started = performance.now();
      await assert.rejects(
        runProgram(
          node,
          parentScript(pidFile, "setInterval(() => {}, 1000)", "setInterval(() => {}, 1000);"),
          { ...base, timeoutMs: 400 },
        ),
        (error: unknown) =>
          error instanceof ProgramError && /timed out after 400 ms/.test(error.message),
      );
      assert.ok(
        performance.now() - started < 3000,
        `settled after ${Math.round(performance.now() - started)} ms`,
      );
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (POSIX) assert.equal(await gone(pid), true, "the grandchild was killed with the group");
      else process.kill(pid);
    });

    it("a program that exits while its grandchild keeps the pipes open settles at the timeout", async () => {
      const pidFile = join(tmp.dir, "exit.pid");
      const started = performance.now();
      await assert.rejects(
        runProgram(node, parentScript(pidFile, "setInterval(() => {}, 1000)", "process.exit(0);"), {
          ...base,
          timeoutMs: 500,
        }),
        (error: unknown) => error instanceof ProgramError && /timed out/.test(error.message),
      );
      assert.ok(performance.now() - started < 3000);
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (POSIX) assert.equal(await gone(pid), true);
      else process.kill(pid);
    });

    it("the output cap settles the call too", async () => {
      const pidFile = join(tmp.dir, "cap.pid");
      await assert.rejects(
        runProgram(
          node,
          parentScript(
            pidFile,
            "setInterval(() => {}, 1000)",
            "process.stdout.write('x'.repeat(5000)); setInterval(() => {}, 1000);",
          ),
          { ...base, maxOutputBytes: 1000 },
        ),
        (error: unknown) =>
          error instanceof ProgramError && /more than 1000 bytes/.test(error.message),
      );
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (POSIX) assert.equal(await gone(pid), true);
      else process.kill(pid);
    });

    it("an engine that is interrupted takes its running programs with it", {
      skip: !POSIX,
    }, async () => {
      const pidFile = join(tmp.dir, "engine.pid");
      const exec = fileURLToPath(new URL("../src/exec.ts", import.meta.url));
      const engine = `
        import { runProgram } from ${JSON.stringify(exec)};
        const script = ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`)};
        await runProgram(process.execPath, ["-e", script], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" }, timeoutMs: 60000, maxOutputBytes: 1024 });
      `;
      const child = spawn(node, ["--input-type=module", "-e", engine], { stdio: "ignore" });
      for (let i = 0; i < 200 && !existsSync(pidFile); i++)
        await new Promise((resolve) => setTimeout(resolve, 25));
      assert.ok(existsSync(pidFile), "the program started");
      const exited = new Promise<NodeJS.Signals | null>((resolve) =>
        child.on("exit", (_code, signal) => resolve(signal)),
      );
      child.kill("SIGTERM");
      assert.equal(await exited, "SIGTERM", "the engine still ends by the signal");
      assert.equal(
        await gone(Number(readFileSync(pidFile, "utf8"))),
        true,
        "its program did not outlive it",
      );
    });
  });

  describe("finding the program", () => {
    let tmp: ReturnType<typeof tempDir>;
    before(() => {
      tmp = tempDir("resolve");
      for (const dir of ["tree", "tree/node_modules/.bin", "bin"])
        mkdirSync(join(tmp.dir, dir), { recursive: true });
      for (const path of ["tree/planted", "tree/node_modules/.bin/planted", "bin/planted"]) {
        writeFileSync(join(tmp.dir, path), "#!/bin/sh\necho planted\n");
        chmodSync(join(tmp.dir, path), 0o755);
      }
    });
    after(() => tmp.cleanup());

    it("never runs a program from the working directory or below it", {
      skip: !POSIX,
    }, async () => {
      const tree = join(tmp.dir, "tree");
      for (const path of [".", "", tree, join(tree, "node_modules", ".bin"), "node_modules/.bin"]) {
        const env = { PATH: `${path}:/usr/bin:/bin` };
        assert.equal(resolveProgram("planted", env, tree), null, JSON.stringify(path));
        await assert.rejects(
          runProgram("planted", [], { ...base, cwd: tree, env }),
          ProgramError,
          JSON.stringify(path),
        );
      }
      const bin = join(tmp.dir, "bin");
      assert.equal(resolveProgram("planted", { PATH: `.:${bin}` }, tree), join(bin, "planted"));
      const run = await runProgram("planted", [], {
        ...base,
        cwd: tree,
        env: { PATH: `.:${bin}` },
      });
      assert.equal(run.stdout.toString("utf8"), "planted\n");
    });

    it("never runs a program from the working directory spelled in another case, or reached through a link", {
      skip: !POSIX,
    }, async () => {
      const tree = join(tmp.dir, "Cased");
      mkdirSync(join(tree, "node_modules", ".bin"), { recursive: true });
      const planted = join(tree, "node_modules", ".bin", "planted");
      writeFileSync(planted, "#!/bin/sh\necho planted\n");
      chmodSync(planted, 0o755);
      const linked = join(tmp.dir, "into-tree");
      symlinkSync(join(tree, "node_modules"), linked);
      const pairs: Array<[string, string]> = [[tree, join(linked, ".bin")]];
      // On a disk that ignores case (the build machine's), the other spellings are the same folder.
      for (const spelled of [join(tmp.dir, "cased"), join(tmp.dir, "CASED")]) {
        if (!existsSync(spelled)) continue;
        pairs.push(
          [tree, join(spelled, "node_modules", ".bin")],
          [spelled, join(tree, "node_modules", ".bin")],
          [spelled, join(spelled, "node_modules", ".bin")],
        );
      }
      for (const [cwd, dir] of pairs) {
        const env = { PATH: `${dir}:/usr/bin:/bin` };
        assert.equal(resolveProgram("planted", env, cwd), null, `${cwd} with ${dir}`);
        await assert.rejects(
          runProgram("planted", [], { ...base, cwd, env }),
          ProgramError,
          `${cwd} with ${dir}`,
        );
      }
      const bin = join(tmp.dir, "bin");
      assert.equal(
        resolveProgram("planted", { PATH: `${join(linked, ".bin")}:${bin}` }, tree),
        join(bin, "planted"),
        "the next folder outside the tree is used",
      );
    });

    it("looks git up on PATH like any other program", async () => {
      const git = resolveProgram("git", { PATH: process.env["PATH"] ?? "" }, tmp.dir);
      assert.ok(git?.endsWith("git"));
      assert.equal(resolveProgram("git", { PATH: "" }, tmp.dir), null);
    });
  });
});
