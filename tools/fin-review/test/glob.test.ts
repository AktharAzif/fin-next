// Path globs for layout tiers, control paths and CI path classes.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileGlob, foldAscii, globError, isPlainPath } from "../src/plan/glob.ts";

function matches(pattern: string, path: string): boolean {
  return compileGlob(pattern).test(path);
}

describe("compileGlob", () => {
  it("** spans any number of directories; * and ? stay inside one segment", () => {
    const cases: Array<[string, string, boolean]> = [
      ["docs/**", "docs/a.md", true],
      ["docs/**", "docs/a/b/c.md", true],
      ["docs/**", "docs", false],
      ["docs/**", "docsx/a.md", false],
      ["**/*.md", "README.md", true],
      ["**/*.md", "a/b/README.md", true],
      ["**/*.md", "a/b/README.mdx", false],
      ["**/*.db.test.ts", "packages/kyc/src/flow.db.test.ts", true],
      ["**/*.db.test.ts", "packages/kyc/src/flow.test.ts", false],
      ["apps/*/src/server/**", "apps/console/src/server/main.ts", true],
      ["apps/*/src/server/**", "apps/console/x/src/server/main.ts", false],
      ["apps/*/index.html", "apps/admin/index.html", true],
      ["apps/*/index.html", "apps/admin/sub/index.html", false],
      ["a/**/b", "a/b", true],
      ["a/**/b", "a/x/y/b", true],
      ["file?.ts", "file1.ts", true],
      ["file?.ts", "file12.ts", false],
      ["**", "anything/at/all", true],
      ["*", "top", true],
      ["*", "a/b", false],
      ["package.json", "package.json", true],
      ["package.json", "apps/console/package.json", false],
      [".github/**", ".github/workflows/ci.yml", true],
      ["tools/fin-review/**", "tools/fin-review/src/main.ts", true],
      ["tools/fin-review/**", "tools/fin-reviewer/x", false],
    ];
    for (const [pattern, path, expected] of cases)
      assert.equal(matches(pattern, path), expected, `${pattern} ~ ${path}`);
  });

  it("ignores case, and treats newlines and spaces in names as ordinary characters", () => {
    assert.equal(matches("docs/**", "DOCS/Plan/X.MD"), true);
    assert.equal(matches("**/*.md", "a dir/with space.md"), true);
    assert.equal(matches("docs/**", "docs/line\nbreak.md"), true);
    assert.equal(matches("*.md", "a\nb.md"), true);
    assert.equal(matches("docs/*.md", "docs/a\n/b.md"), false);
  });

  it("folds ASCII only, so a look-alike letter matches nothing; exact keeps the pattern's case", () => {
    // U+017F (long s) and U+212A (Kelvin sign) fold to s and k on some disks, and in Unicode regexps.
    assert.equal(matches("apps/*/src/server/**", "apps/console/src/ſerver/main.ts"), false);
    assert.equal(matches("packages/**", "pacKages/core/x.ts"), false);
    assert.equal(compileGlob("apps/*").exact("apps/console"), true);
    assert.equal(compileGlob("apps/*").exact("Apps/console"), false);
    assert.equal(compileGlob("apps/*").test("Apps/console"), true);
    assert.equal(
      foldAscii("Apps/K/ſ/É"),
      "apps/K/ſ/É",
      "only A to Z fold, so every offset is kept",
    );
  });

  it("a plain path is printable ASCII only", () => {
    for (const path of ["docs/a b.md", 'docs/"q".md', "a/b~c/[d]{e}.ts", "x"])
      assert.equal(isPlainPath(path), true, path);
    for (const path of [
      "docs/tab\t.md",
      "docs/line\n.md",
      "docs/ü.md",
      "apps/ſerver",
      "pacKages",
      "a\u0000b",
      "a\u007fb",
      "a​b",
    ]) {
      assert.equal(isPlainPath(path), false, JSON.stringify(path));
    }
  });

  it("dots and other regular-expression characters are literal", () => {
    assert.equal(matches("a.b", "aXb"), false);
    assert.equal(matches("a+b", "a+b"), true);
    assert.equal(matches("a+b", "aab"), false);
  });

  it("refuses patterns it would have to guess at", () => {
    for (const pattern of [
      "",
      "a//b",
      "/abs",
      "trailing/",
      "./a",
      "a/../b",
      "a**",
      "**b/c",
      "{a,b}",
      "[ab]",
      "!a",
      "a b",
      "a\\b",
      "a\nb",
    ]) {
      assert.notEqual(globError(pattern), null, JSON.stringify(pattern));
      assert.throws(() => compileGlob(pattern), TypeError);
    }
    assert.notEqual(globError(5), null);
  });
});
