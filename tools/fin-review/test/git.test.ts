// The git output parsers and the program runner (spec 07 §2.1's process rules).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProgramError } from "../src/errors.ts";
import { runProgram } from "../src/exec.ts";
import { gitEnv, isSha, parseCatFileBatch, parseLsTreeZ, parseNameStatusZ } from "../src/git.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("parseNameStatusZ", () => {
  it("reads every status, with renames and copies at both paths", () => {
    const raw = ["M", "src/a.ts", "A", "new file.ts", "D", "gone\nwith newline.ts", "R087", "old/x.ts", "new/x.ts", "C100", "src/b.ts", "src/b copy.ts", "T", "link", ""].join("\0");
    assert.deepEqual(parseNameStatusZ(Buffer.from(raw, "utf8")), [
      { status: "M", score: null, path: "src/a.ts", oldPath: null },
      { status: "A", score: null, path: "new file.ts", oldPath: null },
      { status: "D", score: null, path: "gone\nwith newline.ts", oldPath: null },
      { status: "R", score: 87, path: "new/x.ts", oldPath: "old/x.ts" },
      { status: "C", score: 100, path: "src/b copy.ts", oldPath: "src/b.ts" },
      { status: "T", score: null, path: "link", oldPath: null },
    ]);
    assert.deepEqual(parseNameStatusZ(Buffer.alloc(0)), []);
  });

  it("refuses output it does not recognise", () => {
    for (const raw of ["M\0a", "Z\0a\0", "R100\0only-one\0", "M\0", "MM\0a\0", "R1000\0a\0b\0"]) {
      assert.throws(() => parseNameStatusZ(Buffer.from(raw, "utf8")), TypeError, JSON.stringify(raw));
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
    for (const raw of [`100644 blob ${A} package.json\0`, `100644 blob xyz\tpackage.json\0`, `10064 blob ${A}\tp\0`, `100644 blob ${A} extra\tp\0`, `100644 blob ${A}\tp`]) {
      assert.throws(() => parseLsTreeZ(Buffer.from(raw, "utf8")), TypeError, JSON.stringify(raw));
    }
  });
});

describe("parseCatFileBatch", () => {
  it("reads blobs by object ID, binary content and missing objects included", () => {
    const body = Buffer.from([0x00, 0x0a, 0xff, 0x41]);
    const raw = Buffer.concat([Buffer.from(`${A} blob 4\n`), body, Buffer.from(`\n${B} missing\n`)]);
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
    const env = gitEnv({ PATH: "/usr/bin", HOME: "/home/x", GIT_DIR: "/evil", git_work_tree: "/evil", GIT_EXTERNAL_DIFF: "x", GIT_CONFIG_PARAMETERS: "'a.b=c'", UNSET: undefined });
    assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/home/x", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" });
  });

  it("accepts only 40 lower-case hex characters", () => {
    assert.equal(isSha(A), true);
    for (const value of [A.toUpperCase(), A.slice(1), `${A}0`, `${A.slice(1)}g`, "HEAD", "", 5, null, `${A.slice(0, 39)}\n`]) {
      assert.equal(isSha(value), false, JSON.stringify(value));
    }
  });
});

describe("runProgram", () => {
  const node = process.execPath;
  const base = { cwd: process.cwd(), env: { PATH: process.env["PATH"] ?? "" }, timeoutMs: 10_000, maxOutputBytes: 1 << 20 };

  it("passes arguments as an array with no shell, and the given environment only", async () => {
    const result = await runProgram(node, ["-e", "process.stdout.write(JSON.stringify([process.argv.slice(1), Object.keys(process.env).sort()]))", "a b", "$(echo hi)", "; rm -rf /"], {
      ...base,
      env: { PATH: process.env["PATH"] ?? "", ONLY: "1" },
    });
    assert.equal(result.code, 0);
    const [argv, keys] = JSON.parse(result.stdout.toString("utf8")) as [string[], string[]];
    assert.deepEqual(argv, ["a b", "$(echo hi)", "; rm -rf /"]);
    assert.ok(keys.includes("ONLY"));
    assert.ok(!keys.includes("HOME"));
  });

  it("writes stdin and reports a non-zero exit", async () => {
    const echo = await runProgram(node, ["-e", "process.stdin.pipe(process.stdout)"], { ...base, input: Buffer.from("piped") });
    assert.equal(echo.stdout.toString("utf8"), "piped");
    const fail = await runProgram(node, ["-e", "process.stderr.write('bad'); process.exit(3)"], base);
    assert.deepEqual([fail.code, fail.stderr.toString("utf8")], [3, "bad"]);
  });

  it("kills a program that runs past its timeout", async () => {
    await assert.rejects(runProgram(node, ["-e", "setTimeout(() => {}, 60000)"], { ...base, timeoutMs: 200 }), (error: unknown) => error instanceof ProgramError && /timed out/.test(error.message));
  });

  it("kills a program that writes past the cap", async () => {
    await assert.rejects(runProgram(node, ["-e", "process.stdout.write('x'.repeat(100000))"], { ...base, maxOutputBytes: 1000 }), (error: unknown) => error instanceof ProgramError && /more than 1000 bytes/.test(error.message));
  });

  it("rejects a program that cannot start, and refuses suspicious program names and arguments", async () => {
    await assert.rejects(runProgram("fin-review-no-such-program", [], base), ProgramError);
    await assert.rejects(runProgram("git; rm", [], base), TypeError);
    await assert.rejects(runProgram("git", ["a\0b"], base), TypeError);
    await assert.rejects(runProgram("git", [], { ...base, timeoutMs: 0 }), TypeError);
  });
});
