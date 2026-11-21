// The reviewed tree (src/review/tree.ts): written from the head's blobs, never checked out, and
// refused when a path cannot be shown to a session as it is.

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { lsTree, readBlobs } from "../src/git.ts";
import type { TreeEntry } from "../src/git.ts";
import { entryKind, foldPath, pathTextProblem, TreeError, treeProblems, writeTree } from "../src/review/tree.ts";
import { FixtureRepo, tempDir } from "./helpers/git-fixture.ts";

function entries(...paths: string[]): TreeEntry[] {
  return paths.map((path, index) => ({ mode: "100644", type: "blob", oid: index.toString(16).padStart(40, "0"), path }));
}

describe("the tree's paths (F: paths a session cannot be shown as they are)", () => {
  it("accepts ordinary paths, a folder shared by many files and non-ASCII names that do not fold together", () => {
    assert.deepEqual(treeProblems(entries("README.md", "src/a.ts", "src/b.ts", "docs/café.md", "src/deep/x/y.ts")), []);
  });

  it("refuses a control or format character, bytes that are not UTF-8, and empty, . or .. segments", () => {
    for (const path of ["a\nb.ts", "x\r", "tab\there", "bidi‮exe.ts", "zero​width", "line sep", "bad�.ts", "a//b", "./a", "a/../b", ""]) {
      assert.notEqual(pathTextProblem(path), null, JSON.stringify(path));
      assert.equal(treeProblems(entries(path)).length, 1, JSON.stringify(path));
    }
    assert.match(treeProblems(entries("a\nb.ts"))[0] ?? "", /"a\\u000ab\.ts" holds a control or format character/);
  });

  it("refuses a segment a disk reads as .git, in any case or spelling", () => {
    for (const path of [".git/config", "x/.GIT/hooks/pre-commit", ".git./config", ".git /x", ".g‌it/config", "GIT~1/config"]) {
      assert.equal(treeProblems(entries(path)).length, 1, JSON.stringify(path));
    }
    assert.deepEqual(treeProblems(entries(".github/workflows/ci.yml", ".gitignore", "a.git/x")), []);
  });

  it("refuses two names a disk that ignores case or normalisation takes for one, as files or folders", () => {
    assert.match(treeProblems(entries("src/Guard.ts", "src/guard.ts"))[0] ?? "", /"src\/guard\.ts" and "src\/Guard\.ts" are one name/);
    assert.equal(treeProblems(entries("Lib/evil.ts", "lib")).length, 1, "a folder and a file");
    assert.equal(treeProblems(entries("Lib/a.ts", "lib/b.ts")).length, 1, "two folders");
    assert.equal(treeProblems(entries("café.md", "café.md")).length, 1, "NFC and NFD");
    assert.equal(foldPath("Straße"), foldPath("STRASSE"));
  });

  it("refuses an entry that is neither a file, a link nor a submodule", () => {
    assert.equal(entryKind({ mode: "120000", type: "blob", oid: "0".repeat(40), path: "l" }), "link");
    assert.equal(entryKind({ mode: "160000", type: "commit", oid: "0".repeat(40), path: "s" }), "submodule");
    assert.equal(treeProblems([{ mode: "100644", type: "tag", oid: "0".repeat(40), path: "t" }]).length, 1);
  });
});

describe("writing the tree from blobs", () => {
  let tmp: ReturnType<typeof tempDir>;
  let origin: FixtureRepo;
  let head: string;
  const env = (): Record<string, string> => ({ PATH: process.env["PATH"] ?? "", HOME: tmp.dir });
  const code = "export const check = (a: string, b: string): boolean => a === b; // MARKER-BODY\n";

  before(() => {
    tmp = tempDir("tree");
    mkdirSync(join(tmp.dir, "origin"));
    origin = new FixtureRepo(join(tmp.dir, "origin"));
    const sub = origin.commit(null, { "x.txt": "x\n" });
    head = origin.commit(null, {
      // An attribute that would re-encode the file at checkout, and one that would rewrite its line ends.
      ".gitattributes": "packages/crypto/src/*.ts working-tree-encoding=UTF-16LE\n*.txt eol=crlf\n",
      "packages/crypto/src/index.ts": code,
      "notes.txt": "one\ntwo\n",
      "src/crlf.ts": "export const a = 1;\r\n",
      evil: { symlink: "/etc/passwd" },
      vendor: { gitlink: sub },
    });
  });
  after(() => tmp.cleanup());

  it("writes every blob byte for byte: no attribute acts, CRLF stays, a link is a plain file, a submodule an empty folder, no .git", async () => {
    const tree = await lsTree(origin.dir, head, env());
    const { blobs } = await readBlobs(origin.dir, tree.filter((entry) => entry.type === "blob").map((entry) => entry.oid), env());
    const dir = join(tmp.dir, "trees", "t1");
    writeTree(dir, tree, blobs);
    assert.equal(readFileSync(join(dir, "packages/crypto/src/index.ts"), "utf8"), code, "UTF-8 as committed, not UTF-16");
    assert.equal(readFileSync(join(dir, "notes.txt"), "utf8"), "one\ntwo\n", "LF as committed");
    assert.equal(readFileSync(join(dir, "src/crlf.ts"), "utf8"), "export const a = 1;\r\n");
    assert.ok(lstatSync(join(dir, "evil")).isFile(), "a link is a plain file");
    assert.equal(readFileSync(join(dir, "evil"), "utf8"), "/etc/passwd");
    assert.ok(lstatSync(join(dir, "vendor")).isDirectory());
    assert.deepEqual(readdirSync(join(dir, "vendor")), []);
    assert.ok(!existsSync(join(dir, ".git")));
  });

  it("refuses colliding names before writing anything, and fails closed when the disk already holds a path", async () => {
    const colliding = origin.commit(null, { "src/Guard.ts": "export const g = () => true; // EVIL-BODY\n", "src/guard.ts": "export const g = (a: string) => a === 'k';\n" });
    const tree = await lsTree(origin.dir, colliding, env());
    assert.equal(tree.length, 2, "git keeps both names");
    const { blobs } = await readBlobs(origin.dir, tree.map((entry) => entry.oid), env());
    const dir = join(tmp.dir, "trees", "t2");
    assert.throws(() => writeTree(dir, tree, blobs), (error: unknown) => error instanceof TreeError && /one name on a disk/.test(error.message));
    assert.ok(!existsSync(dir), "nothing is written");

    const taken = join(tmp.dir, "trees", "t3");
    mkdirSync(taken, { recursive: true });
    writeFileSync(join(taken, "a.txt"), "already here\n");
    const one = await lsTree(origin.dir, origin.commit(null, { "a.txt": "new\n" }), env());
    const read = await readBlobs(origin.dir, one.map((entry) => entry.oid), env());
    assert.throws(() => writeTree(taken, one, read.blobs), TreeError, "a file is never overwritten");
    assert.equal(readFileSync(join(taken, "a.txt"), "utf8"), "already here\n");
  });

  it("refuses a head whose blobs the mirror lacks", () => {
    assert.throws(() => writeTree(join(tmp.dir, "trees", "t4"), entries("a.ts"), new Map()), (error: unknown) => error instanceof TreeError && /lacks the blob/.test(error.message));
  });
});
